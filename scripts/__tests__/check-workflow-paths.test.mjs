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
import { MAIN_ONLY_CREDENTIALS } from "../lib/ci-gate-execution.mjs";
import { GATE_REGISTRY, SHARD_COUNTS } from "../lib/gate-registry.mjs";

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

  it('main runs are never cancelled by a newer push; PR runs still are', () => {
    const { concurrency } = wf('.github/workflows/ci-gates.yml');
    const cancels = (ref) => runInNewContext(String(concurrency['cancel-in-progress']).replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { github: { ref } });
    expect(cancels('refs/heads/main')).toBe(false);
    expect(cancels('refs/pull/1/merge')).toBe(true);
    expect(concurrency.group).toContain('${{ github.ref }}');
  });

  it('every plan consumer fetches its own attempt through the fail-fast helper before npm ci', () => {
    const jobs = wf('.github/workflows/ci-gates.yml').jobs;
    const consumers = Object.entries(jobs).filter(([, job]) => job.steps?.some((step) => /ci-(run|aggregate)-gates\.mjs/.test(step.run ?? '')));
    expect(consumers.length).toBeGreaterThanOrEqual(11);
    for (const [id, job] of consumers) {
      const runs = job.steps.map((step) => String(step.run ?? '').trim());
      const download = runs.indexOf('node scripts/ci-download-plan.mjs');
      expect(download, id).toBeGreaterThan(-1);
      if (id !== 'gate-aggregate') expect(download, id).toBeLessThan(runs.indexOf('npm ci'));
      expect(runs.join('\n'), id).not.toContain('--name "gate-plan-attempt-');
    }
  });

  it('gate-aggregate skips npm ci because every module it loads is a Node builtin', () => {
    const steps = wf('.github/workflows/ci-gates.yml').jobs['gate-aggregate'].steps;
    const runs = steps.map((step) => String(step.run ?? '').trim());
    expect(runs).not.toContain('npm ci');
    expect(steps.find((step) => step.uses?.startsWith('actions/setup-node@')).with.cache).toBeUndefined();
    const entries = runs.flatMap((run) => [...run.matchAll(/\bnode (scripts\/[\w./-]+\.mjs)/g)].map((m) => m[1]));
    expect(entries).toEqual(expect.arrayContaining(['scripts/ci-download-plan.mjs', 'scripts/ci-aggregate-gates.mjs']));
    const seen = new Set();
    const external = [];
    const visit = (url) => {
      if (seen.has(url.href)) return;
      seen.add(url.href);
      const text = readFileSync(url, 'utf8');
      // Static, dynamic and side-effect imports; a bare specifier would need node_modules.
      const specifiers = /(?:^|\n)\s*(?:import|export)\b[^'"`;]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
      for (const match of text.matchAll(specifiers)) {
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec.startsWith('.')) visit(new URL(spec, url));
        else if (!spec.startsWith('node:')) external.push(`${spec} <- ${url.pathname.split('/scripts/')[1]}`);
      }
    };
    for (const entry of entries) visit(new URL(`../../${entry}`, import.meta.url));
    expect(seen.size).toBeGreaterThanOrEqual(5);
    expect(external).toEqual([]);
  });

  it('credentials the PR plan defers are exactly those mapped only to main push/dispatch', () => {
    const mapped = new Set();
    for (const job of Object.values(wf('.github/workflows/ci-gates.yml').jobs)) {
      for (const step of job.steps ?? []) {
        for (const [name, value] of Object.entries(step.env ?? {})) {
          if (!String(value).includes('secrets.') || name === 'GH_TOKEN') continue;
          mapped.add(name);
          expect(value, name).toMatch(/^\$\{\{ github\.ref == 'refs\/heads\/main' && \(github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\) && secrets\./);
        }
      }
    }
    expect([...mapped].sort()).toEqual([...MAIN_ONLY_CREDENTIALS].sort());
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

  it('every registry job, shard parts included, has its executor and is awaited by the aggregate', () => {
    const jobs = wf('.github/workflows/ci-gates.yml').jobs;
    const declared = [...new Set(Object.values(GATE_REGISTRY).map((gate) => gate.job))].sort();
    for (const id of declared) {
      expect(jobs[id]?.steps?.some((step) => step.run === `node scripts/ci-run-gates.mjs --job ${id}`), id).toBe(true);
      expect(jobs['gate-aggregate'].needs, id).toContain(id);
    }
    const executors = Object.entries(jobs).filter(([, job]) => job.steps?.some((step) => step.run?.includes('ci-run-gates.mjs'))).map(([id]) => id).sort();
    expect(executors).toEqual(declared);
    for (const [base, count] of Object.entries(SHARD_COUNTS)) {
      const parts = Object.values(GATE_REGISTRY).filter((gate) => gate.shardOf === base);
      expect(parts.map((gate) => gate.shard.index), base).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(new Set(parts.map((gate) => gate.job)).size, `${base}: one job per part`).toBe(count);
    }
  });

  it.each(['quality-gates', 'build-gates', 'suite-tests', 'vitest-tests', 'vitest-tests-2', 'vitest-tests-3', 'secret-scan', 'strict-islands-gate', 'timezone-gate', 'timezone-gate-2', 'timezone-gate-3', 'timezone-gate-4', 'realtime-gates', 'security-gates', 'generated-types-drift', 'reconcile-money', 'cross-tenant-isolation'])('%s executes only from a successful explicit plan', (id) => {
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
    const jobs = wf('.github/workflows/ci-gates.yml').jobs;
    const suites = jobs['suite-tests'];
    expect(suites.steps.find((step) => step.uses?.startsWith('denoland/setup-deno@')).with['deno-version']).toBe('2.9.4');
    // Each conditional install lives in the job that runs the gates needing it.
    const jobOf = (predicate) => [...new Set(Object.values(GATE_REGISTRY).filter(predicate).map((gate) => gate.job))];
    for (const id of jobOf((gate) => gate.command === 'deno')) expect(jobs[id].steps.some((step) => step.uses?.startsWith('denoland/setup-deno@')), id).toBe(true);
    for (const id of jobOf((gate) => gate.id.startsWith('suite:e2e-'))) expect(jobs[id].steps.some((step) => step.run === 'npx playwright install --with-deps chromium'), id).toBe(true);
    for (const id of jobOf((gate) => gate.id === 'docs-build')) expect(jobs[id].steps.some((step) => step.run === 'npm ci --prefix docs-site'), id).toBe(true);
    expect(jobOf((gate) => ['app-build', 'bundle-inventory'].includes(gate.id)), 'bundle-inventory reads the dist of app-build').toHaveLength(1);
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
