// Sổ đột biến cho scripts/check-new-modules-strict.mjs.
//
// Gate này có một cách hỏng đặc thù: nó phụ thuộc LỊCH SỬ GIT. Khi không phân giải
// được mốc (checkout nông, ref không tồn tại) thì "không có file mới" và "không
// kiểm được" trông y hệt nhau nếu cả hai cùng exit 0 — và cái sau bị đọc thành cái
// trước là mất trắng phép kiểm. Vì thế mốc hỏng phải là exit 3.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { docDao, duocMienTru, laModuleApp, MIEN_TRU } from "../check-new-modules-strict.mjs";

describe("laModuleApp — phạm vi luật", () => {
  it("bắt .ts và .tsx trong src/", () => {
    expect(laModuleApp("src/lib/a.ts")).toBe(true);
    expect(laModuleApp("src/pages/B.tsx")).toBe(true);
  });

  it("bỏ file ngoài src/", () => {
    expect(laModuleApp("scripts/x.mjs")).toBe(false);
    expect(laModuleApp("services/worker/src/a.ts")).toBe(false);
    expect(laModuleApp("infra/network-center-worker/src/a.ts")).toBe(false);
  });

  it("bỏ file không phải TS", () => {
    expect(laModuleApp("src/index.css")).toBe(false);
    expect(laModuleApp("src/assets/a.webp")).toBe(false);
  });
});

const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    // Chỉ dọn các repo dùng một lần do chính suite tạo, kể cả trên Windows.
    if (!resolve(fixture).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture path");
    rmSync(fixture, { recursive: true, force: true, maxRetries: 3 });
  }
});

function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), "strict-modules-git-"));
  fixtures.push(root);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const config = (files = []) => write("tsconfig.strict-islands.json", JSON.stringify({ files }));
  git("init", "--initial-branch=main");
  git("config", "user.name", "Gate fixture");
  git("config", "user.email", "gate-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  config();
  git("add", "tsconfig.strict-islands.json");
  git("commit", "-m", "baseline");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  mkdirSync(join(root, "scripts"));
  copyFileSync(fileURLToPath(new URL("../check-new-modules-strict.mjs", import.meta.url)), join(root, "scripts/check-new-modules-strict.mjs"));
  const run = ({ eventName = "", event, args = [], ci = "" } = {}) => {
    const eventPath = join(root, ".git", "event.json");
    if (event !== undefined) writeFileSync(eventPath, JSON.stringify(event));
    const result = spawnSync(process.execPath, [join(root, "scripts/check-new-modules-strict.mjs"), ...args], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, CI: ci, GITHUB_ACTIONS: ci, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: event === undefined ? "" : eventPath },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const commitModule = (path = "src/lib/newModule.ts") => {
    write(path, "export const value = 1;\n");
    git("add", path);
    git("commit", "-m", "add module");
    // GitHub checkout trên push main: origin/main đã trỏ đúng HEAD vừa push.
    git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  };
  return { root, git, write, config, base, run, commitModule };
}

describe("CLI dùng lịch sử Git thật và phạm vi trước commit", () => {
  it("push main dùng before của event khi origin/main đã bằng HEAD", () => {
    const repo = repoFixture();
    repo.commitModule();
    const options = { eventName: "push", event: { before: repo.base }, ci: "true" };
    const failed = repo.run(options);
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toContain("src/lib/newModule.ts");
    repo.config(["src/lib/newModule.ts"]);
    expect(repo.run(options).status).toBe(0);
  });

  it("pull_request lấy base.sha trong payload thay vì ref có thể đã dịch", () => {
    const repo = repoFixture();
    repo.commitModule();
    const result = repo.run({ eventName: "pull_request", event: { pull_request: { base: { sha: repo.base } } }, ci: "true" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("src/lib/newModule.ts");
  });

  it("--base tường minh ưu tiên hơn mốc trong event", () => {
    const repo = repoFixture();
    repo.commitModule();
    const result = repo.run({ eventName: "push", event: { before: repo.git("rev-parse", "HEAD") }, args: ["--base", repo.base] });
    expect(result.status, result.output).toBe(1);
  });

  it("file mới đã stage bị chặn trước commit, còn untracked WIP chỉ cảnh báo local", () => {
    const repo = repoFixture();
    repo.write("src/lib/staged.ts", "export const value = 1;\n");
    repo.write("src/lib/wip.ts", "export const value = 2;\n");
    repo.git("add", "src/lib/staged.ts");
    const failed = repo.run();
    expect(failed.status, failed.output).toBe(1);
    expect(failed.output).toContain("src/lib/staged.ts");
    repo.config(["src/lib/staged.ts"]);
    const passed = repo.run();
    expect(passed.status, passed.output).toBe(0);
    expect(passed.output).toContain("src/lib/wip.ts");
  });

  it("untracked module trên CI là lỗi cứng, không hạ thành WIP local", () => {
    const repo = repoFixture();
    repo.write("src/lib/wip.ts", "export const value = 1;\n");
    const result = repo.run({ ci: "true" });
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("src/lib/wip.ts");
  });

  it.each([{}, { before: "0".repeat(40) }, { before: "f".repeat(40) }])("event push thiếu/mất mốc không được xanh rỗng: %j", (event) => {
    const repo = repoFixture();
    const result = repo.run({ eventName: "push", event, ci: "true" });
    expect(result.status, result.output).toBe(3);
  });

  it("--base thiếu đối số không được rơi về main", () => {
    const repo = repoFixture();
    const result = repo.run({ args: ["--base"] });
    expect(result.status, result.output).toBe(3);
  });
});

describe("miễn trừ — mỗi nhóm một lý do, không phải danh sách cho tiện", () => {
  it("test được miễn: kiểu lỏng trong test là công cụ, không phải nợ", () => {
    expect(duocMienTru("src/lib/__tests__/a.test.ts")).toBe(true);
    expect(duocMienTru("src/lib/a.test.ts")).toBe(true);
    expect(duocMienTru("src/pages/a.spec.tsx")).toBe(true);
  });

  it(".d.ts được miễn: không có thân hàm để strict", () => {
    expect(duocMienTru("src/vite-env.d.ts")).toBe(true);
  });

  it("types.ts sinh tự động được miễn: không sửa tay được", () => {
    expect(duocMienTru("src/integrations/supabase/types.ts")).toBe(true);
  });

  it("KHÔNG miễn mã app thường — nếu không thì luật rỗng", () => {
    expect(duocMienTru("src/lib/tienMoi.ts")).toBe(false);
    expect(duocMienTru("src/pages/TrangMoi.tsx")).toBe(false);
    expect(duocMienTru("src/app/providers/AppProviders.tsx")).toBe(false);
  });

  it("mỗi mục miễn trừ đều có lý do viết ra", () => {
    for (const m of MIEN_TRU) {
      expect(typeof m.vi).toBe("string");
      expect(m.vi.length).toBeGreaterThan(5);
    }
  });
});

describe("docDao — đọc include từ tsconfig JSONC", () => {
  it("bỏ comment dòng và comment khối trước khi parse", () => {
    const s = `{
      // đảo strict — ratchet một chiều
      /* khối
         nhiều dòng */
      "extends": "./tsconfig.app.json",
      "include": ["src/lib/a.ts", "src/lib/b.ts"]
    }`;
    const d = docDao(s);
    expect(d.has("src/lib/a.ts")).toBe(true);
    expect(d.size).toBe(2);
  });

  it("KHÔNG cắt nhầm `//` trong chuỗi URL", () => {
    const s = `{ "$comment": "xem https://ví dụ", "include": ["src/a.ts"] }`;
    expect(docDao(s).has("src/a.ts")).toBe(true);
  });

  it("thiếu include ⇒ tập rỗng, không ném", () => {
    expect(docDao('{"extends":"./x.json"}').size).toBe(0);
  });
});
