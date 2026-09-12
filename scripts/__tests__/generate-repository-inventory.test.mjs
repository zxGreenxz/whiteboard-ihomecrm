// Sổ cho scripts/generate-repository-inventory.mjs.
//
// Ca quan trọng nhất ở đây là `doiSoDau` với lời gọi lồng. Bản đầu của script
// dùng regex lười dừng ở dấu phẩy gần nhất, nên `readFileSync(resolve(dir,'a.ts'))`
// bị cắt thành `resolve(dir` và rơi vào nhóm "không phân loại được". Hệ quả không
// vô hại: nó báo 18 file đọc mã nguồn trong khi con số thật là 32 — thiếu 44%, và
// thiếu theo hướng làm vấn đề trông nhỏ hơn.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { doiSoDau, giaiChuoi, quetMotFile, xepLoai } from "../generate-repository-inventory.mjs";

const sau = (goi) => goi.indexOf("(") + 1;

const fixtureRoots = [];
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inventoryRepo() {
  const root = mkdtempSync(join(tmpdir(), "inventory-git-"));
  fixtureRoots.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(fileURLToPath(new URL("../generate-repository-inventory.mjs", import.meta.url)), join(root, "scripts/generate-repository-inventory.mjs"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  git("init", "-q");
  git("config", "core.autocrlf", "false");
  for (let i = 0; i < 200; i++) put(`tests/${i}.test.mjs`, "export const ok = true;\n");
  put("tests/0.test.mjs", "readFileSync('src/a.ts');\nreadFileSync(runtimePath);\n");
  git("add", "--", "scripts/generate-repository-inventory.mjs", "tests");
  const run = (...args) => spawnSync(process.execPath, [join(root, "scripts/generate-repository-inventory.mjs"), ...args], { cwd: root, encoding: "utf8" });
  const outputPath = join(root, "docs/generated/repository-inventory.json");
  const read = () => readFileSync(outputPath, "utf8");
  expect(run("--write").status).toBe(0);
  return { root, git, put, run, read, outputPath };
}

describe("inventory CLI — source/index và JSON freshness", () => {
  it("bắt JSON cũ dù MD render vẫn khớp JSON sau khi thêm test đã stage", () => {
    const repo = inventoryRepo();
    const old = repo.read();
    repo.put("docs/generated/repository-inventory.md", "- **200** file test\n");
    repo.put("tests/new.test.mjs", "export const added = true;\n");
    repo.git("add", "--", "tests/new.test.mjs");
    expect(repo.run("--check").status).toBe(1);
    expect(repo.read()).toBe(old);
    expect(repo.run("--write").status).toBe(0);
    expect(JSON.parse(repo.read()).tongSoFileTest).toBe(201);
    expect(repo.run("--check").status).toBe(0);
  });

  it("bắt nội dung test đổi khi số file giữ nguyên và giữ số chưa phân loại", () => {
    const repo = inventoryRepo();
    repo.put("tests/1.test.mjs", "readFileSync('schema.sql');\n");
    repo.git("add", "--", "tests/1.test.mjs");
    expect(repo.run("--check").status).toBe(1);
    expect(repo.run("--write").status).toBe(0);
    const result = JSON.parse(repo.read());
    expect(result.tongSoFileTest).toBe(200);
    expect(result.tongLoiGoi).toBe(3);
    expect(result.khongPhanLoaiDuoc).toBe(1);
    expect(result.theoLoai.sql.soFile).toBe(1);
  });

  it.each(["untracked", "modified", "deleted"])("cảnh báo WIP %s nhưng chỉ kiểm blob index; stage thay đổi mới làm inventory stale", (change) => {
    const repo = inventoryRepo();
    if (change === "deleted") {
      // Giữ đủ sàn 200 file sau khi stage deletion để kiểm drift thật.
      repo.put("tests/extra.test.mjs", "export const extra = true;\n");
      repo.git("add", "--", "tests/extra.test.mjs");
      expect(repo.run("--write").status).toBe(0);
    }
    const old = repo.read();
    repo.git("add", "--", "docs/generated/repository-inventory.json");
    if (change === "untracked") repo.put("tests/new.test.mjs", "export const newTest = true;\n");
    if (change === "modified") repo.put("tests/0.test.mjs", "readFileSync('new.sql');\n");
    if (change === "deleted") rmSync(join(repo.root, "tests/0.test.mjs"));
    for (const flags of [["--write"], ["--check"], ["--check", "--nguon-index"]]) {
      const result = repo.run(...flags);
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/WIP/);
      expect(result.stderr).toMatch(/index/i);
      expect(repo.read()).toBe(old);
    }
    repo.git("add", "--", change === "untracked" ? "tests/new.test.mjs" : "tests/0.test.mjs");
    expect(repo.run("--check").status).toBe(1);
    expect(repo.run("--check", "--nguon-index").status).toBe(1);
  });

  it("kiểm artifact trong INDEX, không lấy JSON chưa stage làm bằng chứng cho commit", () => {
    const repo = inventoryRepo();
    repo.git("add", "--", "docs/generated/repository-inventory.json");
    repo.put("tests/new.test.mjs", "export const added = true;\n");
    repo.git("add", "--", "tests/new.test.mjs");
    expect(repo.run("--write").status).toBe(0);
    expect(repo.run("--check").status).toBe(0);
    expect(repo.run("--check", "--nguon-index").status).toBe(1);
    repo.git("add", "--", "docs/generated/repository-inventory.json");
    expect(repo.run("--check", "--nguon-index").status).toBe(0);
  });

  it("thiếu JSON là không kiểm được; sinh hai lần không tạo diff giả", () => {
    const repo = inventoryRepo();
    const old = repo.read();
    expect(repo.run("--write").status).toBe(0);
    expect(repo.read()).toBe(old);
    rmSync(repo.outputPath);
    expect(repo.run("--check").status).toBe(3);
  });
});

describe("doiSoDau — cân bằng ngoặc", () => {
  it("lấy trọn lời gọi LỒNG, không cắt ở dấu phẩy bên trong", () => {
    const s = "readFileSync(resolve(dir, 'a', 'b.ts'), 'utf8')";
    expect(doiSoDau(s, sau(s))).toBe("resolve(dir, 'a', 'b.ts')");
  });

  it("dừng ở dấu phẩy NGOÀI CÙNG (đối số thứ hai không thuộc về nó)", () => {
    const s = "readFileSync(p, 'utf8')";
    expect(doiSoDau(s, sau(s))).toBe("p");
  });

  it("chuỗi nhiều dòng vẫn lấy được", () => {
    const s = "readFileSync(\n  join(root, 'src', 'App.tsx'),\n  'utf8')";
    expect(doiSoDau(s, sau(s))).toContain("App.tsx");
  });

  it("có trần độ dài — biểu thức hỏng không làm nó quét hết file", () => {
    const s = "readFileSync(" + "x".repeat(2000);
    expect(doiSoDau(s, sau(s)).length).toBeLessThanOrEqual(600);
  });
});

describe("giaiChuoi — giải biến trong cùng file", () => {
  const nguon = `
const workerRoot = join(__dirname, "..");
const deploy = join(workerRoot, "scripts", "deploy-vultr.ps1");
const noiDung = readFileSync(deploy, "utf8");
`;

  it("giải được định danh về chuỗi ở nơi khai báo", () => {
    expect(giaiChuoi("deploy", nguon)).toContain("deploy-vultr.ps1");
  });

  it("biểu thức đã có chuỗi thì dùng luôn, không đi tra biến", () => {
    expect(giaiChuoi("join(root, 'a.sql')", nguon)).toEqual(["a.sql"]);
  });

  it("có trần đệ quy — chuỗi khai báo vòng không làm nó treo", () => {
    expect(giaiChuoi("a", "const a = b;\nconst b = a;")).toEqual([]);
  });

  it("định danh không khai trong file trả rỗng, KHÔNG đoán bừa", () => {
    expect(giaiChuoi("khongCoDau", nguon)).toEqual([]);
  });
});

describe("xepLoai — thứ tự khai là thứ tự nghiêm ngặt", () => {
  it("mã nguồn nghiêm hơn manifest khi một biểu thức có cả hai", () => {
    // `readFileSync(join(dir,'tsconfig.json'))` vs một biểu thức chạm cả .ts lẫn
    // .json: phải rơi vào ma-nguon, vì đó mới là thứ cần chuyển sang data-driven.
    expect(xepLoai(["a.ts", "b.json"])).toBe("ma-nguon");
  });

  it("không nhận ra gì thì trả null — null là 'chưa đo được', không phải 'sạch'", () => {
    expect(xepLoai(["/tmp/abc"])).toBeNull();
  });

  it("phân biệt được sql, powershell, tài liệu", () => {
    expect(xepLoai(["001_init.sql"])).toBe("sql");
    expect(xepLoai(["deploy.ps1"])).toBe("powershell");
    expect(xepLoai(["README.md"])).toBe("tai-lieu");
  });
});

describe("quetMotFile", () => {
  it("đếm cả readFileSync lẫn readFile", () => {
    const kq = quetMotFile(`
const a = readFileSync(join(d, 'x.ts'));
const b = await readFile(join(d, 'y.sql'));
`);
    expect(kq.soGoi).toBe(2);
    expect(kq.loai.get("ma-nguon")).toBe(1);
    expect(kq.loai.get("sql")).toBe(1);
  });

  it("đường dẫn dựng lúc chạy vào khongRo, KHÔNG bị gán bừa vào một loại", () => {
    const kq = quetMotFile("const a = readFileSync(tmpFile);");
    expect(kq.khongRo).toBe(1);
    expect(kq.loai.size).toBe(0);
  });

  it("file không đọc gì trả soGoi 0", () => {
    expect(quetMotFile("const a = 1;").soGoi).toBe(0);
  });
});
