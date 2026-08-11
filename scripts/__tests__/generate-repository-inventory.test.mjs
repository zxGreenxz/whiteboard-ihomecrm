// Sổ cho scripts/generate-repository-inventory.mjs.
//
// Ca quan trọng nhất ở đây là `doiSoDau` với lời gọi lồng. Bản đầu của script
// dùng regex lười dừng ở dấu phẩy gần nhất, nên `readFileSync(resolve(dir,'a.ts'))`
// bị cắt thành `resolve(dir` và rơi vào nhóm "không phân loại được". Hệ quả không
// vô hại: nó báo 18 file đọc mã nguồn trong khi con số thật là 32 — thiếu 44%, và
// thiếu theo hướng làm vấn đề trông nhỏ hơn.
import { describe, expect, it } from "vitest";

import { doiSoDau, giaiChuoi, quetMotFile, xepLoai } from "../generate-repository-inventory.mjs";

const sau = (goi) => goi.indexOf("(") + 1;

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
