// Sổ cho scripts/check-workflow-paths.mjs.
//
// Ca đắt nhất ở đây là "kiểm từng trigger, không lấy hợp". Bản đầu của gate lấy
// hợp `push ∪ pull_request`, và đột biến bắt được ngay: bỏ một script khỏi
// `push.paths` vẫn xanh vì `pull_request.paths` còn giữ. Đó là lỗ thật — push lên
// main sẽ không chạy lại workflow, mà main mới là nhánh deploy.
import { readFileSync } from "node:fs";
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
