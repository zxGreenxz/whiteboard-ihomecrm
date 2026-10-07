// Test hồi quy cho gate kiểm soát ngoài repo.
//
// Gate này tự đặt cho mình đúng một nhiệm vụ (header dòng 5-8): "một control có
// thể bị TẮT VỀ SAU; ảnh chụp chứng minh 'lúc đó đã bật', không chứng minh 'bây
// giờ vẫn bật'". Nhưng nó chỉ phủ biến thể KHÔNG GỌI ĐƯỢC control (thiếu token,
// API lỗi, 404). Biến thể GỌI ĐƯỢC và câu trả lời cho thấy control ĐANG TẮT thì
// lọt sạch — nó BÁO CÁO giá trị chứ không SO giá trị với kỳ vọng.
//
// Hậu quả đo được 07/08/2026: ở thế giới cả hai control đều tắt, báo cáo còn
// SẠCH HƠN hiện tại — 3 dấu ✅ và dòng cảnh báo biến mất hoàn toàn.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  interpretProtection,
  readBranchProtection,
  readBranchControl,
  danhGiaNhanh,
  danhGiaRepo,
  danhGiaVercel,
  lyDoTuHttp,
  locPhanOnDinh,
  trangThaiNhanhPhatHanh,
  UNVERIFIED,
} from "../check-external-controls.mjs";

const ok = (data) => ({ ok: true, data });

describe("external-controls CLI evidence", () => {
  function fixture(t) {
    const prefix = join(resolve(tmpdir()), "external-controls-cli-");
    const root = mkdtempSync(prefix);
    t.after(() => {
      assert.ok(resolve(root).startsWith(prefix), "cleanup must stay inside the allocated fixture directory");
      rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts", "check-external-controls.mjs");
    const preload = join(root, "fixture.mjs");
    const evidence = join(root, "docs", "generated", "external-controls.json");
    copyFileSync(new URL("../check-external-controls.mjs", import.meta.url), script);
    // Only the remote boundaries are replaced; the CLI reads/writes real files.
    // No child can reach a network endpoint or the user's credential store.
    writeFileSync(preload, `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      childProcess.execFileSync = (command, args) => {
        if (command !== 'git') throw new Error('Unexpected command: ' + command);
        if (args[0] === 'ls-remote') return 'abc refs/heads/production';
        if (args[0] === 'rev-parse') return 'fixture-head';
        throw new Error('Unexpected git command');
      };
      syncBuiltinESMExports();
      const API = 'https://api.github.com/repos/zxGreenxz/whiteboard-ihomecrm';
      const rules = [
        { type: 'deletion', ruleset_id: 7 },
        { type: 'non_fast_forward', ruleset_id: 7 },
        { type: 'required_status_checks', ruleset_id: 7,
          parameters: { required_status_checks: [{ context: 'quality-gates' }] } },
      ];
      globalThis.fetch = async (url, init = {}) => {
        const authed = Boolean(init.headers?.Authorization);
        const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
        if (url === API) return reply(200, {
          private: false,
          visibility: 'public',
          ...(authed ? { security_and_analysis: {
            secret_scanning: { status: 'enabled' },
            secret_scanning_push_protection: { status: 'enabled' },
          } } : {}),
        });
        if (url === API + '/rules/branches/main' || url === API + '/rules/branches/production') return reply(200, rules);
        if (url === API + '/rulesets/7') return reply(200, authed ? { id: 7, bypass_actors: [] } : { id: 7 });
        if (url === API + '/branches/main/protection' || url === API + '/branches/production/protection') {
          return authed ? reply(404, { message: 'Branch not protected' }) : reply(401, { message: 'Requires authentication' });
        }
        if (url === API + '/branches/main' || url === API + '/branches/production') {
          const name = url.slice(url.lastIndexOf('/') + 1);
          return reply(200, { name, protected: true, protection: { enabled: false } });
        }
        throw new Error('Unexpected URL: ' + url);
      };
    `);
    const run = (...args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, GH_TOKEN: "fixture-only", GITHUB_TOKEN: "", VERCEL_TOKEN: "" },
    });
    // No token: the `gh` fallback is refused by the fixture, so only anonymous
    // reads of public endpoints remain.
    const runAnon = (...args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "", VERCEL_TOKEN: "" },
    });
    const first = run("--write");
    assert.equal(first.status, 0, first.stderr);
    const baseline = JSON.parse(readFileSync(evidence, "utf8"));
    baseline.checkedAt = "2001-01-01T00:00:00.000Z";
    const save = (value) => writeFileSync(evidence, JSON.stringify(value));
    save(baseline);
    const freshOutput = join(root, "fresh", "external-controls.json");
    const failApi = () => writeFileSync(preload,
      "\nglobalThis.fetch = async () => { throw new Error('fixture API unavailable'); };\n", { flag: "a" });
    return { run, runAnon, evidence, freshOutput, baseline, save, failApi };
  }

  it("records visibility, secret scanning and BOTH protected branches as separate controls", (t) => {
    const f = fixture(t);
    const c = f.baseline.controls;
    assert.deepEqual(
      Object.keys(c).filter((k) => k.startsWith("github")),
      ["githubRepoVisibility", "githubSecretScanning", "githubBranchMain", "githubBranchProduction"],
    );
    assert.equal(c.githubRepoVisibility.visibility, "public");
    assert.equal(c.githubSecretScanning.status, "present");
    for (const [key, branch] of [["githubBranchMain", "main"], ["githubBranchProduction", "production"]]) {
      assert.equal(c[key].status, "present");
      assert.equal(c[key].branch, branch);
      assert.deepEqual(c[key].rules, ["deletion", "non_fast_forward", "required_status_checks"]);
      assert.equal(c[key].classicProtection, "absent");
      assert.deepEqual(c[key].bypassActors, []);
    }
  });

  it("combined flags detect drift against the original snapshot and still save fresh evidence", (t) => {
    const f = fixture(t);
    f.baseline.controls.githubBranchMain.requiredChecks = ["old-required-check"];
    f.save(f.baseline);
    const result = f.run("--so-ban-commit", "--write");
    const fresh = JSON.parse(readFileSync(f.evidence, "utf8"));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /ĐỔI so với bản đã commit/);
    assert.deepEqual(fresh.controls.githubBranchMain.requiredChecks, ["quality-gates"]);
    assert.notEqual(fresh.checkedAt, f.baseline.checkedAt);
  });

  it("a ruleset removed from production alone is drift even while main stays protected", (t) => {
    const f = fixture(t);
    f.baseline.controls.githubBranchProduction.rules = ["deletion"];
    f.save(f.baseline);
    const result = f.run("--so-ban-commit");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /ĐỔI so với bản đã commit/);
  });

  it("a separate artifact contains the fresh measurement while the compared baseline stays intact", (t) => {
    const f = fixture(t);
    f.baseline.controls.githubBranchMain.requiredChecks = ["old-required-check"];
    f.save(f.baseline);
    const original = readFileSync(f.evidence, "utf8");
    const result = f.run("--so-ban-commit", "--write", "--output", f.freshOutput);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(readFileSync(f.evidence, "utf8"), original);
    const fresh = JSON.parse(readFileSync(f.freshOutput, "utf8"));
    assert.deepEqual(fresh.controls.githubBranchMain.requiredChecks, ["quality-gates"]);
    assert.notEqual(fresh.checkedAt, f.baseline.checkedAt);
  });

  it("without a token, public rulesets are read anonymously but secret scanning stays unverified", (t) => {
    const f = fixture(t);
    const result = f.runAnon("--write", "--output", f.freshOutput);
    // Unverified is reported, not failed: exit 0 with a warning.
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const c = JSON.parse(readFileSync(f.freshOutput, "utf8")).controls;
    assert.equal(c.githubRepoVisibility.status, "checked");
    assert.equal(c.githubSecretScanning.status, UNVERIFIED);
    assert.equal(c.githubBranchMain.status, "present");
    assert.equal(c.githubBranchProduction.status, "present");
    assert.equal(c.githubBranchMain.classicProtection, "absent");
    assert.equal(c.githubBranchMain.bypassActors, undefined);
    assert.match(c.githubBranchMain.note, /bypass_actors không đọc được/);
    assert.match(result.stdout, /chưa xác minh/);
  });

  it("an admin and a read-only measurement of the same settings do not drift on bypass visibility", (t) => {
    const f = fixture(t);
    const anon = f.runAnon("--write", "--output", f.freshOutput);
    assert.equal(anon.status, 0, anon.stderr);
    const readOnly = JSON.parse(readFileSync(f.freshOutput, "utf8"));
    for (const k of ["githubBranchMain", "githubBranchProduction"]) {
      assert.deepEqual(locPhanOnDinh(readOnly).controls[k], locPhanOnDinh(f.baseline).controls[k]);
    }
  });

  for (const original of ["missing", "malformed"]) {
    it(`combined flags cannot certify a ${original} baseline but preserve the fresh measurement`, (t) => {
      const f = fixture(t);
      if (original === "missing") rmSync(f.evidence);
      else writeFileSync(f.evidence, "{broken-json");
      const result = f.run("--so-ban-commit", "--write", "--output", f.freshOutput);
      assert.equal(result.status, 3, result.stdout + result.stderr);
      assert.match(result.stderr, /KHÔNG SO ĐƯỢC/);
      assert.equal(JSON.parse(readFileSync(f.freshOutput, "utf8")).controls.githubBranchMain.status, "present");
    });
  }

  it("combined flags refresh an unchanged control snapshot without reporting drift", (t) => {
    const f = fixture(t);
    const result = f.run("--so-ban-commit", "--write");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /không đổi so với bản đã commit/);
    assert.notEqual(JSON.parse(readFileSync(f.evidence, "utf8")).checkedAt, f.baseline.checkedAt);
  });

  it("comparison alone leaves the original evidence intact when controls drift", (t) => {
    const f = fixture(t);
    f.baseline.controls.githubBranchMain.requiredChecks = ["old-required-check"];
    f.save(f.baseline);
    const original = readFileSync(f.evidence, "utf8");
    assert.equal(f.run("--so-ban-commit").status, 1);
    assert.equal(readFileSync(f.evidence, "utf8"), original);
  });

  it("an API failure cannot publish the committed snapshot as fresh evidence", (t) => {
    const f = fixture(t);
    const original = readFileSync(f.evidence, "utf8");
    f.failApi();
    const result = f.run("--so-ban-commit", "--write", "--output", f.freshOutput);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /fixture API unavailable/);
    assert.equal(existsSync(f.freshOutput), false);
    assert.equal(readFileSync(f.evidence, "utf8"), original);
  });
});

describe("branch protection with contents-read credentials", () => {
  const detailPath = "repos/zxGreenxz/whiteboard-ihomecrm/branches/main/protection";
  const branchPath = "repos/zxGreenxz/whiteboard-ihomecrm/branches/main";
  function reader(branch) {
    return async (path) => {
      if (path === detailPath) return { ok: false, reason: "http-403" };
      assert.equal(path, branchPath);
      return branch;
    };
  }

  it("403 details plus explicit unprotected main metadata proves absence without admin access", async () => {
    const result = await readBranchProtection(reader(ok({ name: "main", protected: false })));
    assert.equal(result.status, "absent");
    assert.match(result.note, /protected=false/);
  });

  for (const data of [
    { name: "main", protected: true },
    { name: "main" },
    { name: "main", protected: null },
    { name: "main", protected: "false" },
    { name: "other", protected: false },
  ]) {
    it(`metadata ${JSON.stringify(data)} cannot certify protection absent or effective`, async () => {
      assert.equal((await readBranchProtection(reader(ok(data)))).status, UNVERIFIED);
    });
  }

  it("unreadable branch metadata preserves unverified", async () => {
    assert.equal((await readBranchProtection(reader({ ok: false, reason: "not-found" }))).status, UNVERIFIED);
  });

  it("a transport failure cannot become evidence that protection is absent", async () => {
    await assert.rejects(readBranchProtection(async (path) => {
      if (path === detailPath) return { ok: false, reason: "http-403" };
      throw new Error("network unavailable");
    }), /network unavailable/);
  });

  it("successful details retain hollow detection and do not use metadata as an override", async () => {
    const result = await readBranchProtection(async (path) => {
      assert.equal(path, detailPath);
      return ok({ required_status_checks: null, required_pull_request_reviews: null });
    });
    assert.equal(result.status, "hollow");
  });

  it("a non-permission API failure is not replaced by a branch metadata response", async () => {
    const result = await readBranchProtection(async (path) => {
      assert.equal(path, detailPath);
      return { ok: false, reason: "http-500" };
    });
    assert.equal(result.status, UNVERIFIED);
  });

  it("protected:true from a ruleset with classic protection.enabled=false proves classic absence", async () => {
    // Measured shape on 07/10/2026 after the owner created rulesets: the branch
    // reports protected:true, but the classic summary says enabled:false.
    const result = await readBranchProtection(reader(ok({ name: "main", protected: true, protection: { enabled: false } })));
    assert.equal(result.status, "absent");
    assert.match(result.note, /enabled=false/);
  });

  for (const enabled of [true, "false", null, undefined]) {
    it(`classic protection.enabled=${String(enabled)} with protected:true stays unverified`, async () => {
      const result = await readBranchProtection(reader(ok({ name: "main", protected: true, protection: { enabled } })));
      assert.equal(result.status, UNVERIFIED);
    });
  }

  it("anonymous 401 on details falls back to metadata exactly like a contents-read 403", async () => {
    const result = await readBranchProtection(async (path) => {
      if (path === detailPath) return { ok: false, reason: "http-401" };
      assert.equal(path, branchPath);
      return ok({ name: "main", protected: false });
    });
    assert.equal(result.status, "absent");
  });

  it("checks the requested branch, not main, when asked about production", async () => {
    const seen = [];
    const result = await readBranchProtection(async (path) => {
      seen.push(path);
      if (path.endsWith("/protection")) return { ok: false, reason: "http-403" };
      return ok({ name: "production", protected: false });
    }, "production");
    assert.deepEqual(seen, [
      "repos/zxGreenxz/whiteboard-ihomecrm/branches/production/protection",
      "repos/zxGreenxz/whiteboard-ihomecrm/branches/production",
    ]);
    assert.equal(result.status, "absent");
  });

  it("metadata for another branch name cannot prove production unprotected", async () => {
    const result = await readBranchProtection(async (path) =>
      path.endsWith("/protection") ? { ok: false, reason: "http-403" } : ok({ name: "main", protected: false }), "production");
    assert.equal(result.status, UNVERIFIED);
  });
});

describe("lyDoTuHttp — 404 ẩn danh không phải 'không có'", () => {
  it("404 with a token is not-found; anonymous 404 is unreadable", () => {
    assert.equal(lyDoTuHttp(404, false), "not-found");
    assert.equal(lyDoTuHttp(404, true), "an-danh-khong-thay");
    assert.equal(lyDoTuHttp(403, false), "http-403");
  });

  it("an anonymous 404 on the protection endpoint stays unverified, never absent", () => {
    // A private repo answers every anonymous request with 404.
    assert.equal(interpretProtection({ ok: false, reason: lyDoTuHttp(404, true) }).status, UNVERIFIED);
  });
});

describe("danhGiaRepo — repo public phải có secret scanning + push protection", () => {
  const repo = (visibility, saa) => ok({
    private: visibility !== "public",
    visibility,
    ...(saa === undefined ? {} : { security_and_analysis: saa }),
  });
  const saa = (ss, pp) => ({
    secret_scanning: { status: ss },
    secret_scanning_push_protection: { status: pp },
  });

  it("public + both enabled ⇒ present, visibility recorded", () => {
    const r = danhGiaRepo(repo("public", saa("enabled", "enabled")));
    assert.equal(r.visibility.status, "checked");
    assert.equal(r.visibility.visibility, "public");
    assert.equal(r.secretScanning.status, "present");
  });

  for (const [ss, pp] of [["disabled", "enabled"], ["enabled", "disabled"], ["disabled", "disabled"]]) {
    it(`public + secret_scanning=${ss}, push_protection=${pp} ⇒ failed`, () => {
      const r = danhGiaRepo(repo("public", saa(ss, pp)));
      assert.equal(r.secretScanning.status, "failed");
      assert.match(r.secretScanning.note, /TẮT/);
    });
  }

  it("security_and_analysis hidden (non-admin token) ⇒ unverified, NOT failed and NOT present", () => {
    const r = danhGiaRepo(repo("public"));
    assert.equal(r.secretScanning.status, UNVERIFIED);
    assert.equal(r.secretScanning.secretScanning, null);
    assert.equal(r.visibility.status, "checked");
  });

  it("unknown status values cannot certify the control", () => {
    assert.equal(danhGiaRepo(repo("public", saa("enabled", "weird"))).secretScanning.status, UNVERIFIED);
    assert.equal(danhGiaRepo(repo("public", { secret_scanning: { status: "enabled" } })).secretScanning.status, UNVERIFIED);
  });

  it("private + disabled ⇒ absent (not public yet), not failed", () => {
    const r = danhGiaRepo(repo("private", saa("disabled", "disabled")));
    assert.equal(r.visibility.visibility, "private");
    assert.equal(r.secretScanning.status, "absent");
  });

  it("unreadable repo ⇒ both controls unverified", () => {
    const r = danhGiaRepo({ ok: false, reason: "http-500" });
    assert.equal(r.visibility.status, UNVERIFIED);
    assert.equal(r.secretScanning.status, UNVERIFIED);
  });

  it("a response without visibility/private cannot be judged", () => {
    assert.equal(danhGiaRepo(ok({})).visibility.status, UNVERIFIED);
  });
});

describe("danhGiaNhanh — ruleset phải chặn CẢ xoá lẫn force-push", () => {
  const rule = (type, extra = {}) => ({ type, ruleset_id: 9, ...extra });
  const absent = { status: "absent" };

  it("deletion + non_fast_forward, no bypass ⇒ present; missing required checks points at the known gap", () => {
    const r = danhGiaNhanh("production", ok([rule("deletion"), rule("non_fast_forward")]), absent, { 9: [] });
    assert.equal(r.status, "present");
    assert.deepEqual(r.requiredChecks, []);
    assert.deepEqual(r.rulesetIds, [9]);
    assert.match(r.note, /required-checks-khong-cuong-che-duoc/);
  });

  for (const only of ["deletion", "non_fast_forward"]) {
    it(`only ${only} ⇒ hollow`, () => {
      assert.equal(danhGiaNhanh("main", ok([rule(only)]), absent, { 9: [] }).status, "hollow");
    });
  }

  it("a required-check-only ruleset still lets history be rewritten ⇒ hollow", () => {
    const r = danhGiaNhanh("main", ok([rule("required_status_checks", {
      parameters: { required_status_checks: [{ context: "gate-aggregate" }] },
    })]), absent, { 9: [] });
    assert.equal(r.status, "hollow");
    assert.deepEqual(r.requiredChecks, ["gate-aggregate"]);
  });

  it("an always-bypass actor makes the rules hollow; pull_request-only bypass does not", () => {
    const rules = ok([rule("deletion"), rule("non_fast_forward")]);
    const always = danhGiaNhanh("main", rules, absent, { 9: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }] });
    assert.equal(always.status, "hollow");
    assert.match(always.note, /bypass/);
    const viaPr = danhGiaNhanh("main", rules, absent, { 9: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "pull_request" }] });
    assert.equal(viaPr.status, "present");
  });

  it("unreadable bypass actors keep present but say so, and omit the field", () => {
    const r = danhGiaNhanh("main", ok([rule("deletion"), rule("non_fast_forward")]), absent, { 9: null });
    assert.equal(r.status, "present");
    assert.equal(r.bypassActors, undefined);
    assert.match(r.note, /bypass_actors không đọc được/);
  });

  it("no ruleset and no classic protection ⇒ absent", () => {
    assert.equal(danhGiaNhanh("main", ok([]), absent).status, "absent");
  });

  it("no ruleset and unverifiable classic protection ⇒ unverified", () => {
    assert.equal(danhGiaNhanh("main", ok([]), { status: UNVERIFIED }).status, UNVERIFIED);
  });

  it("unreadable rulesets: classic absence cannot prove the branch is bare ⇒ unverified", () => {
    assert.equal(danhGiaNhanh("main", { ok: false, reason: "http-500" }, absent).status, UNVERIFIED);
  });

  it("unreadable rulesets but effective classic protection ⇒ present", () => {
    const r = danhGiaNhanh("main", { ok: false, reason: "http-500" }, { status: "present", requiredChecks: ["quality-gates"] });
    assert.equal(r.status, "present");
    assert.deepEqual(r.requiredChecks, ["quality-gates"]);
  });

  it("hollow classic protection alone does not count as blocking", () => {
    assert.equal(danhGiaNhanh("main", ok([]), { status: "hollow" }).status, "hollow");
  });

  it("the three verdict classes stay distinct (anti green-by-collapse)", () => {
    const seen = new Set([
      danhGiaNhanh("main", ok([rule("deletion"), rule("non_fast_forward")]), absent, { 9: [] }).status,
      danhGiaNhanh("main", ok([rule("deletion")]), absent, { 9: [] }).status,
      danhGiaNhanh("main", ok([]), absent).status,
      danhGiaNhanh("main", { ok: false, reason: "x" }, absent).status,
    ]);
    assert.equal(seen.size, 4);
  });
});

describe("readBranchControl — đọc đúng nhánh và ruleset", () => {
  it("reads rules for the given branch and bypass actors once per ruleset", async () => {
    const seen = [];
    const r = await readBranchControl("production", async (path) => {
      seen.push(path);
      if (path.endsWith("/rules/branches/production")) {
        return ok([{ type: "deletion", ruleset_id: 3 }, { type: "non_fast_forward", ruleset_id: 3 }]);
      }
      if (path.endsWith("/branches/production/protection")) return { ok: false, reason: "not-found" };
      if (path.endsWith("/rulesets/3")) return ok({ id: 3, bypass_actors: [] });
      throw new Error("unexpected " + path);
    });
    assert.equal(r.status, "present");
    assert.equal(r.branch, "production");
    assert.equal(seen.filter((p) => p.endsWith("/rulesets/3")).length, 1);
    assert.ok(!seen.some((p) => p.includes("/main")), "production must not be judged from main");
  });
});

describe("interpretProtection — HTTP 200 không có nghĩa là đang bảo vệ", () => {
  it("protection RỖNG RUỘT (200 nhưng không chặn gì) ⇒ hollow", () => {
    const r = interpretProtection(ok({
      required_status_checks: null,
      required_pull_request_reviews: null,
      enforce_admins: { enabled: false },
      allow_force_pushes: { enabled: true },
      allow_deletions: { enabled: true },
    }));
    assert.equal(r.status, "hollow");
  });

  it("có required check + duyệt + áp cho admin ⇒ present", () => {
    const r = interpretProtection(ok({
      required_status_checks: { contexts: ["quality-gates"] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    }));
    assert.equal(r.status, "present");
  });

  it("có nội dung nhưng vẫn cho force-push ⇒ hollow (lịch sử main ghi đè được)", () => {
    const r = interpretProtection(ok({
      required_status_checks: { contexts: ["quality-gates"] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: true },
      allow_deletions: { enabled: false },
    }));
    assert.equal(r.status, "hollow");
  });

  it("thiếu credential ⇒ unverified, KHÔNG phải absent (chưa kiểm khác với đã tắt)", () => {
    assert.equal(interpretProtection({ ok: false, reason: "no-credential" }).status, UNVERIFIED);
  });

  it("404 ⇒ absent", () => {
    assert.equal(interpretProtection({ ok: false, reason: "not-found" }).status, "absent");
  });
});

describe("danhGiaVercel — production branch bị gạt về main phải ĐỎ", () => {
  // danhGiaVercel CHỈ phán trên project deploy TỪ REPO NÀY (đổi 11/08/2026, lô 26):
  // tài khoản Vercel còn ihome-market và n2store thuộc repo khác, và repo này không
  // sửa được cấu hình của chúng bằng bất kỳ commit nào. Fixture thiếu `repo` sẽ bị
  // lọc hết ⇒ 0 project trong phạm vi ⇒ `unverified`, không phải `failed`.
  const REPO = "zxGreenxz/whiteboard-ihomecrm";
  it("production branch = main ⇒ failed", () => {
    // Kịch bản thật: ai đó vào dashboard Vercel gạt production branch từ
    // 'production' về 'main' ⇒ mọi push vào main lại là một lần phát hành.
    const r = danhGiaVercel([{ name: "ihomecrm", repo: REPO, productionBranch: "main" }]);
    assert.equal(r.status, "failed");
  });

  it("productionBranch null (mặc định = main) ⇒ failed", () => {
    assert.equal(danhGiaVercel([{ name: "ihomecrm", repo: REPO, productionBranch: null }]).status, "failed");
  });

  it("production branch đúng ⇒ checked", () => {
    assert.equal(
      danhGiaVercel([{ name: "ihomecrm", repo: REPO, productionBranch: "production" }]).status,
      "checked",
    );
  });

  it("một project sai trong nhiều project ⇒ failed", () => {
    const r = danhGiaVercel([
      { name: "a", repo: REPO, productionBranch: "production" },
      { name: "b", repo: REPO, productionBranch: "main" },
    ]);
    assert.equal(r.status, "failed");
    assert.match(r.note, /b→main/);
  });

  it("project của repo KHÁC không kéo kết luận — ngoài phạm vi thì ngoài phạm vi", () => {
    // Trước lô 26 hàm này phán trên MỌI project của tài khoản, và đo thật 08/08/2026
    // cho ra 'failed' vì hai project thuộc repo khác deploy từ main. Một gate đỏ vì
    // thứ nó không sửa được sẽ bị bỏ qua.
    const r = danhGiaVercel([
      { name: "ihomecrm", repo: REPO, productionBranch: "production" },
      { name: "ihome-market", repo: "zxGreenxz/ihome-market", productionBranch: "main" },
    ]);
    assert.equal(r.status, "checked");
  });

  it("KHÔNG project nào thuộc repo này ⇒ unverified, KHÔNG phải checked", () => {
    // Lọc quá tay cũng phải ồn ào: không còn gì để đối chiếu thì không kết luận được.
    assert.equal(
      danhGiaVercel([{ name: "khac", repo: "ai-do/khac", productionBranch: "main" }]).status,
      UNVERIFIED,
    );
  });

  it("0 project ⇒ unverified, KHÔNG phải checked (token sai team cũng trả 200)", () => {
    assert.equal(danhGiaVercel([]).status, UNVERIFIED);
  });
});

describe("trangThaiNhanhPhatHanh — ba trạng thái, không phải hai", () => {
  it("hỏi được và CÓ nhánh ⇒ present", () => {
    assert.equal(trangThaiNhanhPhatHanh(true).status, "present");
  });

  it("hỏi được và KHÔNG có nhánh ⇒ absent", () => {
    assert.equal(trangThaiNhanhPhatHanh(false).status, "absent");
    assert.match(trangThaiNhanhPhatHanh(false).note, /mọi push vào main là một lần phát hành/);
  });

  it("HỎI KHÔNG ĐƯỢC ⇒ unverified, KHÔNG phải absent", () => {
    // Đây là ca đắt nhất trong file này, và nó có từ một lỗi THẬT: 12/08/2026
    // lượt chạy đầu báo `absent`, lượt ngay sau báo `present`, nhánh vẫn nằm
    // nguyên trên remote. `read()` trả null khi `git ls-remote` hỏng (mất mạng),
    // và bản cũ gộp null vào cùng ô với "đã hỏi, không có".
    //
    // Hậu quả không chỉ là một dòng sai: nó khẳng định kiểm soát an toàn phát
    // hành KHÔNG TỒN TẠI trong khi nó vẫn còn đó. Một cảnh báo sai kiểu đó làm
    // người đọc thôi tin cả bảng — đúng thứ mà đầu file này đã chê.
    for (const v of [null, undefined]) {
      assert.equal(trangThaiNhanhPhatHanh(v).status, UNVERIFIED, `với ${String(v)}`);
      assert.match(trangThaiNhanhPhatHanh(v).note, /Chưa kiểm được KHÁC với không tồn tại/);
    }
  });

  it("ba trạng thái là BA giá trị khác nhau", () => {
    // Chống-xanh-rỗng: nếu ai đó gộp lại hai trong ba, ca này đỏ ngay.
    const ra = new Set([true, false, null].map((v) => trangThaiNhanhPhatHanh(v).status));
    assert.equal(ra.size, 3);
  });
});
