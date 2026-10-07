// Sổ cho scripts/ci-download-plan.mjs: "Re-run failed jobs" không có plan của lượt
// mới; job phải dừng sớm và nói rõ cách chạy lại, không đỏ bằng lỗi gh khó hiểu.
import { describe, expect, it } from "vitest";

import { loiThieuPlan, taiPlan } from "../ci-download-plan.mjs";

describe("taiPlan", () => {
  it("tải đúng artifact của lượt hiện tại", () => {
    const calls = [];
    const result = taiPlan({ runId: "42", attempt: "3", download: (args) => { calls.push(args); return 0; } });
    expect(result.code).toBe(0);
    expect(calls).toEqual([["run", "download", "42", "--name", "gate-plan-attempt-3", "--dir", ".gate-evidence"]]);
  });

  it("lượt chạy lại thiếu plan ⇒ đỏ kèm hướng dẫn Re-run all jobs", () => {
    const result = taiPlan({ runId: "42", attempt: "2", download: () => 1 });
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/Re-run all jobs/);
  });

  it("lượt đầu thiếu plan là lỗi preflight, không đổ cho chạy lại", () => {
    expect(taiPlan({ runId: "42", attempt: "1", download: () => 1 }).message).not.toMatch(/Re-run/);
    expect(loiThieuPlan("1")).toMatch(/preflight/);
  });

  it.each([[undefined, "1"], ["42", undefined], ["42; rm", "1"], ["42", "1 --repo x"]])("biến môi trường lạ (%s, %s) không tới được gh", (runId, attempt) => {
    let called = false;
    expect(taiPlan({ runId, attempt, download: () => { called = true; return 0; } }).code).toBe(1);
    expect(called).toBe(false);
  });
});
