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
  danhGiaVercel,
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
      globalThis.fetch = async (url) => {
        if (url !== 'https://api.github.com/repos/zxGreenxz/whiteboard-ihomecrm/branches/main/protection') {
          throw new Error('Unexpected URL: ' + url);
        }
        return { ok: true, status: 200, json: async () => ({
          required_status_checks: { contexts: ['quality-gates'] },
          required_pull_request_reviews: { required_approving_review_count: 1 },
          enforce_admins: { enabled: true },
          allow_force_pushes: { enabled: false },
          allow_deletions: { enabled: false },
        }) };
      };
    `);
    const run = (...args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, GH_TOKEN: "fixture-only", GITHUB_TOKEN: "", VERCEL_TOKEN: "" },
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
    return { run, evidence, freshOutput, baseline, save, failApi };
  }

  it("combined flags detect drift against the original snapshot and still save fresh evidence", (t) => {
    const f = fixture(t);
    f.baseline.controls.githubBranchProtection.requiredChecks = ["old-required-check"];
    f.save(f.baseline);
    const result = f.run("--so-ban-commit", "--write");
    const fresh = JSON.parse(readFileSync(f.evidence, "utf8"));
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /ĐỔI so với bản đã commit/);
    assert.deepEqual(fresh.controls.githubBranchProtection.requiredChecks, ["quality-gates"]);
    assert.notEqual(fresh.checkedAt, f.baseline.checkedAt);
  });

  it("a separate artifact contains the fresh measurement while the compared baseline stays intact", (t) => {
    const f = fixture(t);
    f.baseline.controls.githubBranchProtection.requiredChecks = ["old-required-check"];
    f.save(f.baseline);
    const original = readFileSync(f.evidence, "utf8");
    const result = f.run("--so-ban-commit", "--write", "--output", f.freshOutput);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(readFileSync(f.evidence, "utf8"), original);
    const fresh = JSON.parse(readFileSync(f.freshOutput, "utf8"));
    assert.deepEqual(fresh.controls.githubBranchProtection.requiredChecks, ["quality-gates"]);
    assert.notEqual(fresh.checkedAt, f.baseline.checkedAt);
  });

  for (const original of ["missing", "malformed"]) {
    it(`combined flags cannot certify a ${original} baseline but preserve the fresh measurement`, (t) => {
      const f = fixture(t);
      if (original === "missing") rmSync(f.evidence);
      else writeFileSync(f.evidence, "{broken-json");
      const result = f.run("--so-ban-commit", "--write", "--output", f.freshOutput);
      assert.equal(result.status, 3, result.stdout + result.stderr);
      assert.match(result.stderr, /KHÔNG SO ĐƯỢC/);
      assert.equal(JSON.parse(readFileSync(f.freshOutput, "utf8")).controls.githubBranchProtection.status, "present");
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
    f.baseline.controls.githubBranchProtection.requiredChecks = ["old-required-check"];
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
