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
  const jobActive = (job, eventName, ref, needs = LOC_CO_MA_NGUON) => runInNewContext(
    job.if,
    { github: { event_name: eventName, ref }, needs },
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
  // sở hữu ĐỘC LẬP của suite app-unit và `needs` trống là bất biến có test.
  it.each(["quality-gates", "secret-scan", "vitest-tests"])(
    "%s: không bao giờ bị bộ lọc đường dẫn bỏ qua",
    (ten) => {
      const job = wf(".github/workflows/ci-gates.yml").jobs[ten];
      expect(job.needs).toBeUndefined();
      expect(String(job.if)).not.toContain("ma_nguon");
      expect(jobActive(job, "pull_request", "refs/pull/123/merge", LOC_CHI_TAI_LIEU)).toBe(true);
    },
  );

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
