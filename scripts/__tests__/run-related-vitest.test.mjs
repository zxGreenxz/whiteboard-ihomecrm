// Sổ cho scripts/run-related-vitest.mjs: Vitest liên quan chỉ dò trong bộ app-unit,
// và không để file cấu hình kéo Vitest chạy lại toàn bộ trên máy.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { chonRelated, nguonLienQuan, testThuocAppUnit } from "../run-related-vitest.mjs";

const matrix = JSON.parse(readFileSync(new URL("../../tooling/test-matrix.json", import.meta.url), "utf8"));

describe("run-related-vitest", () => {
  it("chỉ dò file JS/TS; bỏ file làm Vitest chạy lại toàn bộ và file đã xoá khỏi index", () => {
    expect(nguonLienQuan(["src/a.ts", "src/b.tsx", "scripts/c.mjs", "docs/x.md", "package.json", "vite.config.ts", "tooling/test-matrix.json", "src/gone.ts"], (p) => p !== "src/gone.ts"))
      .toEqual(["src/a.ts", "src/b.tsx", "scripts/c.mjs"]);
  });

  it("chỉ test thuộc app-unit: loại node:test, Playwright và DEFERRED", () => {
    const owned = testThuocAppUnit([
      "src/lib/__tests__/permissions.test.ts",
      "scripts/__tests__/promote-to-production.test.mjs",
      "scripts/__tests__/ci-gate-execution.test.mjs",
      ".e2e-fleet/specs/personal-finance-demo.spec.ts",
      "src/copilot/model.test.ts",
      "src/lib/permissions.ts",
    ], matrix);
    expect(owned).toEqual(["src/lib/__tests__/permissions.test.ts", "scripts/__tests__/promote-to-production.test.mjs"]);
  });

  it("không chạy lại test mà bộ app-unit hẹp vừa chạy trong cùng lượt", () => {
    const tracked = ["src/a.ts", "src/a.test.ts", "src/b.test.ts"];
    const plan = { changedPaths: ["src/a.ts"], suiteSelections: [{ id: "app-unit", mode: "targeted", files: ["src/a.test.ts"] }] };
    expect(chonRelated(plan, { tracked, matrix })).toEqual({ related: ["src/a.ts"], include: ["src/b.test.ts"] });
    // Bộ app-unit "all" giao cho CI (không chạy ở máy) nên không loại gì.
    expect(chonRelated({ ...plan, suiteSelections: [{ id: "app-unit", mode: "all", files: ["src/a.test.ts"] }] }, { tracked, matrix }).include).toHaveLength(2);
  });
});
