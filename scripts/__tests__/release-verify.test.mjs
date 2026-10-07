// Sổ cho scripts/release-verify.mjs: push production thành công chưa phải phát hành
// xong. Ca dễ xanh giả nhất là deployment của project khác (ptcrm-docs) cùng SHA.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { chonDeployment, docBuildSha, parseWaitSeconds, resolveCommitSha, verifyVercelRelease } from "../release-verify.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("resolveCommitSha", () => {
  it("phân giải commit thật thành đủ 40 ký tự, kể cả SHA ngắn", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(resolveCommitSha(head.slice(0, 8))).toBe(head);
    expect(resolveCommitSha("HEAD")).toBe(head);
  });

  it.each([undefined, "", "--apply", "khong-co-commit-nay", "0".repeat(40)])("từ chối %j thay vì để GitHub khớp rỗng", (input) => {
    expect(() => resolveCommitSha(input)).toThrow(/commit/);
  });

  it("đầu ra git không đủ 40 hex vẫn bị từ chối", () => {
    expect(() => resolveCommitSha("x", () => "abc123")).toThrow(/40 ký tự/);
    expect(resolveCommitSha("x", () => SHA)).toBe(SHA);
  });
});

describe("đọc trang và chọn deployment", () => {
  it("đọc meta build-sha bất kể thứ tự thuộc tính", () => {
    expect(docBuildSha(`<meta name="build-sha" content="${SHA}" />`)).toBe(SHA);
    expect(docBuildSha(`<META content='${SHA}' name='build-sha'>`)).toBe(SHA);
    expect(docBuildSha('<meta name="description" content="x">')).toBeNull();
    expect(docBuildSha(undefined)).toBeNull();
  });

  it("chỉ nhận deployment production của ihomecrm đúng SHA, mới nhất trước", () => {
    const d = (name, sha, created, extra = {}) => ({ name, target: "production", meta: { githubCommitSha: sha }, created, state: "READY", ...extra });
    expect(chonDeployment([d("ptcrm-docs", SHA, 9)], SHA)).toBeNull();
    expect(chonDeployment([d("ihomecrm", OTHER, 9)], SHA)).toBeNull();
    expect(chonDeployment([d("ihomecrm", SHA, 9, { target: "preview" })], SHA)).toBeNull();
    expect(chonDeployment([d("ihomecrm", SHA, 1, { state: "ERROR" }), d("ihomecrm", SHA, 2), d("ptcrm-docs", SHA, 3)], SHA).created).toBe(2);
    expect(chonDeployment(undefined, SHA)).toBeNull();
  });

  it("giới hạn thời gian chờ", () => {
    expect(parseWaitSeconds([], 900)).toBe(900);
    expect(parseWaitSeconds(["--wait-seconds", "0"], 900)).toBe(0);
    for (const bad of ["-1", "1.5", "1801", "x"]) expect(() => parseWaitSeconds(["--wait-seconds", bad], 900)).toThrow();
  });
});

describe("verifyVercelRelease", () => {
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => String(body) });
  const html = (sha) => ({ ok: true, status: 200, text: async () => `<html><head><meta name="build-sha" content="${sha}" /></head></html>` });
  const deployment = (state, name = "ihomecrm", sha = SHA) => ({ name, target: "production", state, created: 1, meta: { githubCommitSha: sha } });
  function harness(timeline, { page = () => html(SHA), project = { name: "ihomecrm", id: "prj" } } = {}) {
    let time = 0;
    const calls = [];
    const request = async (url, init) => {
      calls.push({ url, init });
      if (url === "https://api.vercel.com/v9/projects/ihomecrm") return json(project);
      if (url.startsWith("https://api.vercel.com/v6/deployments?projectId=prj&target=production")) {
        const next = timeline.length > 1 ? timeline.shift() : timeline[0];
        return typeof next === "number" ? json({}, next) : json({ deployments: next });
      }
      if (url.startsWith("https://ptcrm.vercel.app/")) return page();
      throw new Error(`Unexpected URL ${url}`);
    };
    const run = (waitMs = 60) => verifyVercelRelease({ sha: SHA, token: "fixture", request, waitMs, pollMs: 10, now: () => time, sleep: async (ms) => { time += ms; }, log: () => {} });
    return { run, calls, clock: () => time };
  }

  it("thiếu VERCEL_TOKEN là chưa kiểm (3), không phải đạt", async () => {
    expect((await verifyVercelRelease({ sha: SHA, token: "" })).code).toBe(3);
  });

  it("chờ deployment từ BUILDING tới READY rồi đối chiếu trang thật", async () => {
    const h = harness([[], [deployment("BUILDING")], [deployment("READY")]]);
    const result = await h.run();
    expect(result.code).toBe(0);
    expect(h.calls.every((c) => !c.init?.method || c.init.method === "GET")).toBe(true);
    expect(h.calls.find((c) => c.url.startsWith("https://api.vercel.com/")).init.headers.Authorization).toBe("Bearer fixture");
  });

  it.each(["ERROR", "CANCELED"])("deployment %s là đỏ ngay (1), không chờ", async (state) => {
    const h = harness([[deployment(state)]]);
    expect((await h.run()).code).toBe(1);
    expect(h.clock()).toBe(0);
  });

  it("READY nhưng trang vẫn chạy commit khác tới hết giờ ⇒ 1", async () => {
    const h = harness([[deployment("READY")]], { page: () => html(OTHER) });
    const result = await h.run();
    expect(result.code).toBe(1);
    expect(result.message).toMatch(/bbbbbbbbbbbb/);
  });

  it("alias trỏ sang chậm vẫn đạt khi trang đổi trước hạn", async () => {
    const pages = [html(OTHER), html(OTHER), html(SHA)];
    expect((await harness([[deployment("READY")]], { page: () => pages.shift() }).run()).code).toBe(0);
  });

  it("chỉ có deployment ptcrm-docs cùng SHA ⇒ hết giờ, chưa kiểm được (3)", async () => {
    const result = await harness([[deployment("READY", "ptcrm-docs")]]).run();
    expect(result.code).toBe(3);
    expect(result.message).toMatch(/Hết giờ/);
  });

  it("lỗi API và project lạ là chưa kiểm được (3)", async () => {
    expect((await harness([403]).run()).code).toBe(3);
    expect((await harness([[]], { project: { name: "ptcrm-docs", id: "x" } }).run()).code).toBe(3);
  });
});
