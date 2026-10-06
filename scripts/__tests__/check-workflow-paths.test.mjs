// Sổ cho scripts/check-workflow-paths.mjs.
//
// Ca đắt nhất ở đây là "kiểm từng trigger, không lấy hợp". Bản đầu của gate lấy
// hợp `push ∪ pull_request`, và đột biến bắt được ngay: bỏ một script khỏi
// `push.paths` vẫn xanh vì `pull_request.paths` còn giữ. Đó là lỗ thật — push lên
// main sẽ không chạy lại workflow, mà main mới là nhánh deploy.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { duocPhu, globSangRegex, layOn, scriptDuocGoi } from "../check-workflow-paths.mjs";

describe("globSangRegex", () => {
  it("`**` vượt qua dấu gạch chéo", () => {
    expect(duocPhu("scripts/check-network-center-x.mjs", ["scripts/**network-center**"])).toBe(true);
  });

  it("`*` KHÔNG vượt dấu gạch chéo", () => {
    expect(duocPhu("scripts/sub/a.mjs", ["scripts/*.mjs"])).toBe(false);
    expect(duocPhu("scripts/a.mjs", ["scripts/*.mjs"])).toBe(true);
  });

  it("dấu chấm là ký tự thường", () => {
    expect(globSangRegex("a.mjs").test("axmjs")).toBe(false);
  });

  it("mẫu thư mục `x/**` phủ file bên trong", () => {
    expect(duocPhu("supabase/migrations/001.sql", ["supabase/migrations/**"])).toBe(true);
  });
});

describe("layOn — bẫy YAML 1.1", () => {
  it("`on:` bị đọc thành khoá boolean true vẫn lấy được", () => {
    // js-yaml theo YAML 1.1 hiểu `on` là true. Ai viết gate mà không biết chỗ này
    // sẽ thấy `doc.on === undefined` rồi kết luận "workflow không có trigger".
    const doc = yaml.load("on:\n  push:\n    paths: ['a']\n");
    expect(layOn(doc)).not.toBeNull();
    expect(layOn(doc).push.paths).toEqual(["a"]);
  });

  it("không có trigger nào thì trả null, KHÔNG trả {} giả vờ hợp lệ", () => {
    expect(layOn({ jobs: {} })).toBeNull();
  });
});

describe("scriptDuocGoi", () => {
  const doc = (run) => yaml.load(`jobs:\n  j:\n    steps:\n      - run: ${run}\n`);

  it("bắt được lời gọi trong chuỗi gấp nhiều dòng", () => {
    expect(scriptDuocGoi(doc("|\n          node scripts/a.mjs\n          node scripts/b.mjs"))).toEqual([
      "scripts/a.mjs",
      "scripts/b.mjs",
    ]);
  });

  it("khử trùng lặp và sắp xếp — kết quả phải ổn định giữa các lần chạy", () => {
    expect(scriptDuocGoi(doc("|\n          node scripts/b.mjs\n          node scripts/b.mjs"))).toEqual(["scripts/b.mjs"]);
  });

  it("không bắt nhầm đường dẫn không phải .mjs trong scripts/", () => {
    expect(scriptDuocGoi(doc("cat scripts/readme.md"))).toEqual([]);
  });
});

describe("trạng thái thật của repo", () => {
  const wf = (p) => yaml.load(readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"));

  // These job conditions use the shared JS/Actions subset: context strings,
  // equality and boolean operators. Evaluate the parsed YAML for real events.
  //
  // `needs` joined the context on 15/09/2026, when four jobs started reading the
  // path filter published by `preflight`. Its default here is the filter saying
  // "source changed" — the case that must keep behaving exactly as before.
  const LOC_CO_MA_NGUON = { preflight: { outputs: { ma_nguon: "true" } } };
  const LOC_CHI_TAI_LIEU = { preflight: { outputs: { ma_nguon: "false" } } };
  // `run_attempt` mặc định "1" (lượt chạy đầu); `cancelled()` mặc định false.
  const jobActive = (job, eventName, ref, needs = LOC_CO_MA_NGUON, runAttempt = "1") => runInNewContext(
    job.if,
    { github: { event_name: eventName, ref, run_attempt: runAttempt }, needs, cancelled: () => false },
    { timeout: 100 },
  );

  it.each([
    ["push", "refs/heads/main", false],
    ["workflow_dispatch", "refs/heads/main", false],
    ["pull_request", "refs/pull/123/merge", false],
    ["push", "refs/heads/release/candidate", false],
    ["workflow_dispatch", "refs/heads/release/candidate", false],
    ["push", "refs/heads/production", true],
    ["workflow_dispatch", "refs/heads/production", true],
  ])("production promotion activation: %s on %s → %s", (eventName, ref, expected) => {
    const job = wf(".github/workflows/ci-gates.yml").jobs["production-promotion"];
    expect(jobActive(job, eventName, ref)).toBe(expected);
  });

  it.each([
    ["push", "refs/heads/main", true],
    ["workflow_dispatch", "refs/heads/main", true],
    ["pull_request", "refs/pull/123/merge", true],
    ["push", "refs/heads/release/candidate", true],
    ["push", "refs/heads/production", false],
    ["workflow_dispatch", "refs/heads/production", false],
  ])("full Vitest activation: %s on %s → %s", (eventName, ref, expected) => {
    const job = wf(".github/workflows/ci-gates.yml").jobs["vitest-tests"];
    expect(job, "full Vitest job must exist").toBeDefined();
    expect(jobActive(job, eventName, ref)).toBe(expected);
  });

  // Bộ lọc đường dẫn (15/09/2026) chỉ được phép BỚT việc, và chỉ đúng một chiều:
  // thay đổi chạm mã nguồn thì bốn job vẫn chạy y như trước; chỉ khi bộ lọc nói
  // "toàn tài liệu" chúng mới được nghỉ. Ca dưới khoá cả hai chiều để không ai
  // vô tình nới bộ lọc rộng ra thành "gần như luôn bỏ qua".
  it.each(["strict-islands-gate", "timezone-gate", "realtime-gates"])(
    "%s: đụng mã nguồn ⇒ chạy; chỉ tài liệu ⇒ nghỉ",
    (ten) => {
      const job = wf(".github/workflows/ci-gates.yml").jobs[ten];
      expect(job, `${ten} phải tồn tại`).toBeDefined();
      expect(job.needs).toBe("preflight");
      expect(jobActive(job, "pull_request", "refs/pull/123/merge")).toBe(true);
      expect(jobActive(job, "pull_request", "refs/pull/123/merge", LOC_CHI_TAI_LIEU)).toBe(false);
    },
  );

  // Ba job này KHÔNG được gắn bộ lọc, kể cả khi ai đó thấy chúng tốn:
  // secret-scan vì tài liệu cũng lộ được secret; quality-gates vì nó chứa chính
  // các gate đếm số tài liệu; vitest-tests vì test-matrix.json khai nó là chủ
  // sở hữu ĐỘC LẬP của suite app-unit. Từ 01/10/2026 chúng chỉ chờ `preflight`
  // (~10 s, để đọc `pr_da_xanh`), không bao giờ chờ quality-gates.
  it.each(["quality-gates", "secret-scan", "vitest-tests"])(
    "%s: không bao giờ bị bộ lọc đường dẫn bỏ qua",
    (ten) => {
      const job = wf(".github/workflows/ci-gates.yml").jobs[ten];
      expect([undefined, "preflight"]).toContain(job.needs);
      expect(String(job.if)).not.toContain("ma_nguon");
      expect(jobActive(job, "pull_request", "refs/pull/123/merge", LOC_CHI_TAI_LIEU)).toBe(true);
    },
  );

  // CI main không chạy lại phần tĩnh THUẦN khi chính SHA đó đã có lượt
  // pull_request xanh (01/10/2026). Đo: lượt main chạy lại y hệt PR mất 7–10
  // phút, job chậm nhất là timezone-gate. Chỉ job kết quả phụ thuộc DUY NHẤT vào
  // cây mã mới được nghỉ; job đọc database thật hoặc phụ thuộc thời gian
  // (quality-gates, realtime-gates, security…) luôn chạy trên main. Bằng chứng
  // xanh của job được nghỉ nằm ở lượt PR, và promote đòi bằng chứng đó.
  const PR_DA_XANH = { preflight: { outputs: { ma_nguon: "true", pr_da_xanh: "true" } } };
  const JOB_DUOC_NGHI = ["secret-scan", "vitest-tests", "strict-islands-gate", "timezone-gate"];

  it.each(JOB_DUOC_NGHI)("%s: push main lượt đầu + PR cùng SHA đã xanh ⇒ nghỉ; mọi trường hợp khác ⇒ chạy", (ten) => {
    const job = wf(".github/workflows/ci-gates.yml").jobs[ten];
    expect(job.needs).toBe("preflight");
    expect(jobActive(job, "push", "refs/heads/main", PR_DA_XANH)).toBe(false);
    expect(jobActive(job, "push", "refs/heads/main")).toBe(true);
    expect(jobActive(job, "push", "refs/heads/main", PR_DA_XANH, "2"), "chạy lại thì chạy đủ").toBe(true);
    expect(jobActive(job, "pull_request", "refs/pull/123/merge", PR_DA_XANH)).toBe(true);
    expect(jobActive(job, "push", "refs/heads/release/candidate", PR_DA_XANH)).toBe(true);
    expect(jobActive(job, "workflow_dispatch", "refs/heads/main", PR_DA_XANH)).toBe(true);
  });

  it.each(["vitest-tests", "secret-scan"])("%s: preflight hỏng (output rỗng) vẫn chạy — `!cancelled()` thay cho success() ngầm", (ten) => {
    const job = wf(".github/workflows/ci-gates.yml").jobs[ten];
    expect(String(job.if)).toContain("!cancelled()");
    expect(jobActive(job, "push", "refs/heads/main", { preflight: { outputs: {} } })).toBe(true);
  });

  it.each(["quality-gates", "realtime-gates", "security-gates", "generated-types-drift", "reconcile-money", "cross-tenant-isolation"])(
    "%s: phụ thuộc database thật hoặc thời gian ⇒ vẫn chạy trên main dù PR đã xanh",
    (ten) => {
      const job = wf(".github/workflows/ci-gates.yml").jobs[ten];
      expect(String(job.if)).not.toContain("pr_da_xanh");
      const coSecret = { preflight: { outputs: { ...PR_DA_XANH.preflight.outputs, has_pat: "true", has_cli_token: "true", has_test_creds: "true" } } };
      expect(jobActive(job, "push", "refs/heads/main", coSecret)).toBe(true);
    },
  );

  it("preflight chỉ hỏi GitHub khi push main, chỉ tin lượt PR xanh 24 giờ, cùng repo, có PR vào main", () => {
    const job = wf(".github/workflows/ci-gates.yml").jobs.preflight;
    expect(job.permissions).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
    expect(job.outputs.pr_da_xanh).toBe("${{ steps.pr.outputs.pr_da_xanh }}");
    const step = job.steps.find((s) => s.id === "pr");
    expect(step, "phải có bước id: pr").toBeDefined();
    expect(runInNewContext(step.if, { github: { event_name: "push", ref: "refs/heads/main" } })).toBe(true);
    expect(runInNewContext(step.if, { github: { event_name: "pull_request", ref: "refs/pull/1/merge" } })).toBe(false);
    for (const phan of [
      "event=pull_request", "status=success", "head_sha=${GITHUB_SHA}", "ci-gates.yml",
      "created=%3E%3D", "24 hours ago", "head_repository.full_name", "commits/${GITHUB_SHA}/pulls",
      'base.ref == "main"', "timeout 30 gh api",
    ]) {
      expect(step.run).toContain(phan);
    }
    // Hai kết quả phải CÙNG đúng mới được ghi true; bỏ một vế là nghỉ nhầm.
    expect(step.run).toMatch(
      /if \[ "\$\{n:-0\}" -gt 0 \] 2>\/dev\/null && \[ "\$\{base:-0\}" -gt 0 \] 2>\/dev\/null; then\s+echo "pr_da_xanh=true"/,
    );
  });

  it("JOB_TINH của promote khớp tên job thật và không job nào dính bộ lọc đường dẫn", async () => {
    // Đổi tên job mà quên danh sách thì chốt thieuBangChungTinh tắt im lặng; còn
    // job dính bộ lọc đường dẫn thì PR chỉ-docs bị chốt chặn nhầm.
    const { JOB_TINH } = await import("../promote-to-production.mjs");
    const jobs = wf(".github/workflows/ci-gates.yml").jobs;
    for (const ten of JOB_TINH) {
      expect(jobs[ten], `${ten} phải là job của ci-gates.yml`).toBeDefined();
      // API GitHub trả TÊN HIỂN THỊ; job không có `name:` thì tên đó chính là id.
      expect(jobs[ten].name, `${ten} không được có name: riêng — promote so theo tên hiển thị`).toBeUndefined();
      expect(String(jobs[ten].if)).not.toContain("ma_nguon");
    }
    // Danh sách job được nghỉ suy từ CHÍNH workflow: thêm job nghỉ mới mà quên khai là đỏ.
    const nghiThat = Object.keys(jobs).filter((k) => String(jobs[k].if).includes("pr_da_xanh")).sort();
    expect(nghiThat).toEqual([...JOB_DUOC_NGHI].sort());
    for (const ten of nghiThat.filter((t) => !String(jobs[t].if).includes("ma_nguon"))) {
      expect(JOB_TINH, `${ten} được nghỉ trên main thì promote phải đòi bằng chứng của nó`).toContain(ten);
    }
  });

  it("deferred Copilot cannot run through CI or its retained manual workflow", () => {
    const job = wf(".github/workflows/ci-gates.yml").jobs["quality-gates"];
    const commands = job.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/node scripts\/(?:check-copilot-|run-copilot-|generate-copilot-|check-golden-eval-report)/);
    expect(commands).not.toMatch(/^\s+scripts\/__tests__\/[^\n]*copilot[^\n]*\\$/m);
    expect(commands).toContain('supabase/functions/llm-proxy/index.test.ts');
    expect(commands).toContain('supabase/functions/quick-entry/index.test.ts');
    expect(commands).toContain('scripts/__tests__/check-migration-provenance.test.mjs');
    const dormant = wf('.github/workflows/copilot-e2e.yml');
    expect(layOn(dormant).schedule).toBeUndefined();
    expect(dormant.jobs['copilot-e2e'].if).toBe('${{ false }}');
  });

  it("supabase-migrate: mọi script job chạy đều được CẢ push phủ", () => {
    const doc = wf(".github/workflows/supabase-migrate.yml");
    const paths = layOn(doc).push.paths;
    const scripts = scriptDuocGoi(doc);
    // Sàn chống-xanh-rỗng: nếu job không còn gọi script nào thì ca này vô nghĩa.
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for (const s of scripts) expect(duocPhu(s, paths), `${s} không được phủ`).toBe(true);
  });

  it("network-center: phủ ở CẢ HAI trigger, không dựa vào cái kia bù", () => {
    const doc = wf(".github/workflows/network-center-validation.yml");
    const on = layOn(doc);
    const scripts = scriptDuocGoi(doc);
    expect(scripts.length).toBeGreaterThanOrEqual(10);
    for (const trigger of ["push", "pull_request"]) {
      for (const s of scripts) {
        expect(duocPhu(s, on[trigger].paths), `${s} thiếu ở on.${trigger}.paths`).toBe(true);
      }
    }
  });
});
