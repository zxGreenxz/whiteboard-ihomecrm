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

  const active = (job, needs, ref = 'refs/heads/main') => runInNewContext(job.if, {
    github: { ref, event_name: 'push' }, needs, cancelled: () => false, always: () => true,
    fromJSON: JSON.parse, contains: (values, value) => values.includes(value),
  });

  it('aggregate runs after failed preflight and waits for every execution job', () => {
    const jobs = wf('.github/workflows/ci-gates.yml').jobs;
    const aggregate = jobs['gate-aggregate'];
    expect(aggregate).toBeDefined();
    expect(active(aggregate, { preflight: { result: 'failure' } })).toBe(true);
    expect(active(aggregate, {}, 'refs/heads/production')).toBe(false);
    for (const [id, job] of Object.entries(jobs)) {
      if (job.steps?.some((step) => step.run?.includes('ci-run-gates.mjs'))) expect(aggregate.needs).toContain(id);
    }
  });

  it.each(['quality-gates', 'vitest-tests', 'secret-scan', 'strict-islands-gate', 'timezone-gate', 'realtime-gates', 'security-gates', 'generated-types-drift', 'reconcile-money', 'cross-tenant-isolation'])('%s executes only from a successful explicit plan', (id) => {
    const job = wf('.github/workflows/ci-gates.yml').jobs[id];
    const needs = (result, ids) => ({ preflight: { result, outputs: { required_jobs: JSON.stringify(ids) } } });
    expect(active(job, needs('success', [id]))).toBe(true);
    expect(active(job, needs('success', []))).toBe(false);
    expect(active(job, needs('failure', [id]))).toBe(false);
    expect(job.needs).toBe('preflight');
    expect(job.steps.some((step) => step.run === `node scripts/ci-run-gates.mjs --job ${id}`)).toBe(true);
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload.if).toBe('always()');
  });

  it('preflight plans the checkout and selected jobs have no old all-or-nothing PR skip', () => {
    const jobs = wf('.github/workflows/ci-gates.yml').jobs;
    expect(jobs.preflight.steps.some((step) => step.run === 'node scripts/ci-gate-plan.mjs')).toBe(true);
    for (const job of Object.values(jobs)) expect(String(job.if)).not.toMatch(/ma_nguon|pr_da_xanh/);
    expect(jobs['vitest-tests'].needs).not.toBe('quality-gates');
    expect(jobs['production-promotion'].steps.some((step) => step.run?.includes('promote-to-production.mjs'))).toBe(true);
  });

  it('deferred workflow stays off and shared Deno setup stays pinned', () => {
    const quality = wf('.github/workflows/ci-gates.yml').jobs['quality-gates'];
    expect(quality.steps.find((step) => step.uses?.startsWith('denoland/setup-deno@')).with['deno-version']).toBe('2.9.4');
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
