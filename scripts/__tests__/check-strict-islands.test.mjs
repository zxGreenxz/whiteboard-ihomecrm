// Sổ cho scripts/check-strict-islands.mjs.
//
// Gate này trước lát 97 KHÔNG có test nào — nó chỉ có đột biến chạy tay lúc dựng.
// Đó là chỗ hở đáng kể vì chính nó đã từng xanh-rỗng một lần: bản đầu đặt
// `strict: true` ở tsconfig con và tưởng thế là đủ, trong khi `tsconfig.app.json`
// đặt tường minh `noImplicitAny: false` và giá trị tường minh của cha THẮNG cái
// mặc-định-suy-từ-`strict` của con. Đảo chạy suốt mà không hề bắt implicit any.
//
// Vì vậy các ca dưới đây bám vào hai thứ dễ trôi nhất: cờ có CÒN HIỆU LỰC sau khi
// hợp nhất extends, và bất biến tầng-con-⊆-tầng-cha.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CO_BAT_BUOC,
  DAO,
  doJsonc,
  docDao,
  locDao,
  timConNgoaiCha,
  locDaoTheoTen,
  thamSoTsc,
  timCoBiTat,
  timDaoBiRut,
} from "../check-strict-islands.mjs";

const goc = new URL("../../", import.meta.url);
const docJson = (p) => JSON.parse(doJsonc(readFileSync(new URL(p, goc), "utf8")));

describe("timCoBiTat — cờ phải còn hiệu lực SAU khi hợp nhất extends", () => {
  const dayDu = Object.fromEntries(CO_BAT_BUOC.map((k) => [k, true]));

  it("đủ cờ ⇒ không thiếu gì", () => {
    expect(timCoBiTat(dayDu)).toEqual([]);
  });

  it("cha tắt một cờ ⇒ chỉ ra ĐÚNG TÊN cờ đó", () => {
    // Đây là án lệ thật của repo: `noImplicitAny: false` ở tsconfig cha.
    expect(timCoBiTat({ ...dayDu, noImplicitAny: false })).toEqual(["noImplicitAny"]);
  });

  it("cờ VẮNG MẶT cũng tính là tắt — `undefined` không phải `true`", () => {
    const thieu = { ...dayDu };
    delete thieu.strictNullChecks;
    expect(timCoBiTat(thieu)).toEqual(["strictNullChecks"]);
  });

  it("`coThem` là cờ riêng của tầng, và nó BỊ KIỂM chứ không phải trang trí", () => {
    expect(timCoBiTat(dayDu, ["noUncheckedIndexedAccess"])).toEqual(["noUncheckedIndexedAccess"]);
    expect(timCoBiTat({ ...dayDu, noUncheckedIndexedAccess: true }, ["noUncheckedIndexedAccess"])).toEqual([]);
  });
});

describe("timConNgoaiCha — bất biến tầng con ⊆ tầng cha", () => {
  it("con nằm gọn trong cha ⇒ rỗng", () => {
    expect(timConNgoaiCha(["a.ts", "b.ts"], ["a.ts", "b.ts", "c.ts"])).toEqual([]);
  });

  it("con có file cha không có ⇒ chỉ đích danh", () => {
    // Nếu lọt, file đó bị khoá ở mức CAO mà không bị khoá ở mức THẤP — gỡ nó khỏi
    // tầng cha sẽ không ai báo, và câu "tầng 2 nghiêm hơn tầng 1" thành sai.
    expect(timConNgoaiCha(["a.ts", "z.ts"], ["a.ts"])).toEqual(["z.ts"]);
  });

  it("cha rỗng ⇒ mọi file của con đều bị chỉ ra, không im lặng cho qua", () => {
    expect(timConNgoaiCha(["a.ts"], [])).toEqual(["a.ts"]);
  });
});

describe("locDao / timDaoBiRut / doJsonc", () => {
  it("locDao bỏ file khai kiểu môi trường và chuẩn hoá dấu gạch", () => {
    expect(locDao(["src/vite-env.d.ts", "src\\a\\b.ts"])).toEqual(["src/a/b.ts"]);
  });

  it("timDaoBiRut bắt đảo có trong baseline mà biến khỏi include", () => {
    expect(timDaoBiRut(["a.ts", "b.ts"], ["a.ts"])).toEqual(["b.ts"]);
    expect(timDaoBiRut(["a.ts"], ["a.ts", "b.ts"])).toEqual([]);
  });

  it("doJsonc đọc được tsconfig có comment", () => {
    expect(JSON.parse(doJsonc('{ /* x */ "a": 1 } // đuôi'))).toEqual({ a: 1 });
  });

  it("docDao đọc danh sách file cố định mà không phụ thuộc include", () => {
    expect(docDao('{ "files": ["src/a.ts"], "include": [] }')).toEqual(["src/a.ts"]);
  });
});

describe("bảng DAO — khai báo phải khớp file thật", () => {
  it("chống-xanh-rỗng: bảng không rỗng", () => {
    // Bảng rỗng ⇒ vòng lặp không chạy lần nào ⇒ gate im lặng trả 0.
    expect(DAO.length).toBeGreaterThanOrEqual(2);
  });

  it("mọi tsconfig và baseline khai trong bảng đều TỒN TẠI", () => {
    for (const d of DAO) {
      expect(existsSync(new URL(d.tsconfig, goc)), `${d.ten}: thiếu ${d.tsconfig}`).toBe(true);
      expect(existsSync(new URL(d.baseline.replace(/\\/g, "/"), goc)), `${d.ten}: thiếu ${d.baseline}`).toBe(true);
    }
  });

  it("sàn chống-rỗng của mỗi tầng phải THẤP HƠN số đảo thật — nhưng không thấp vô nghĩa", () => {
    for (const d of DAO) {
      const soDao = locDao(docDao(readFileSync(new URL(d.tsconfig, goc), "utf8"))).length;
      expect(soDao, `${d.ten}: ${soDao} đảo mà sàn ${d.toiThieu}`).toBeGreaterThan(d.toiThieu);
      // Sàn thấp hơn nửa mức thật thì nó không còn chặn được việc cắt danh sách.
      expect(d.toiThieu, `${d.ten}: sàn quá thấp so với ${soDao}`).toBeGreaterThan(soDao / 2);
    }
  });

  it("baseline của mỗi tầng là TẬP CON của include tầng đó", () => {
    for (const d of DAO) {
      const include = new Set(locDao(docDao(readFileSync(new URL(d.tsconfig, goc), "utf8"))));
      const baseline = JSON.parse(readFileSync(new URL(d.baseline.replace(/\\/g, "/"), goc), "utf8")).islands;
      expect(timDaoBiRut(baseline, [...include]), `${d.ten} có đảo bị rút`).toEqual([]);
    }
  });

  it("trên FILE THẬT: mọi tầng có `conCua` đều là tập con của tầng cha", () => {
    const coCha = DAO.filter((d) => d.conCua);
    // Chống-xanh-rỗng: nếu không tầng nào khai cha thì ca này chẳng kiểm gì.
    expect(coCha.length).toBeGreaterThanOrEqual(1);
    for (const d of coCha) {
      const con = locDao(docDao(readFileSync(new URL(d.tsconfig, goc), "utf8")));
      const cha = locDao(docDao(readFileSync(new URL(d.conCua, goc), "utf8")));
      expect(timConNgoaiCha(con, cha), `${d.ten} vượt ra ngoài ${d.conCua}`).toEqual([]);
    }
  });

  it("tầng có `coThem` phải thực sự BẬT cờ đó trong tsconfig của nó", () => {
    for (const d of DAO.filter((x) => x.coThem.length > 0)) {
      const opts = docJson(d.tsconfig).compilerOptions ?? {};
      for (const co of d.coThem) {
        expect(opts[co], `${d.ten}: khai coThem ${co} nhưng tsconfig không bật`).toBe(true);
      }
    }
  });
});

// Cache tăng dần (01/10/2026): đảo "strict" lượt đầu 108 s, lượt sau 7 s. tsc
// ghi phiên bản compiler, option và băm từng file vào buildinfo rồi tự dựng lại
// khi lệch, nên cache cũ không cho ra kết luận cũ. Mỗi đảo một file buildinfo
// riêng: hai đảo dùng chung một file thì lượt này ghi đè cache của lượt kia.
describe("thamSoTsc", () => {
  it("bật --incremental, buildinfo nằm trong .tscache/ và vẫn --noEmit", () => {
    const args = thamSoTsc("tsconfig.strict-islands.json");
    expect(args.slice(0, 3)).toEqual(["tsc", "-p", "tsconfig.strict-islands.json"]);
    expect(args).toContain("--noEmit");
    expect(args).toContain("--incremental");
    const buildInfo = args[args.indexOf("--tsBuildInfoFile") + 1];
    expect(buildInfo.startsWith(".tscache/")).toBe(true);
  });

  it("mỗi đảo một file buildinfo riêng", () => {
    const files = DAO.map((d) => {
      const args = thamSoTsc(d.tsconfig);
      return args[args.indexOf("--tsBuildInfoFile") + 1];
    });
    expect(new Set(files).size).toBe(DAO.length);
  });
});

// `--dao <tên>` (01/10/2026): gate:truoc-push chạy MỖI ĐẢO MỘT CỬA để hai lượt
// tsc nguội chạy song song. Đo: hai đảo nối tiếp mất 209 s khi máy đang bận.
// CI vẫn gọi không kèm cờ ⇒ kiểm đủ mọi đảo như cũ.
describe("locDaoTheoTen", () => {
  it("không chỉ định ⇒ mọi đảo", () => {
    expect(locDaoTheoTen(DAO, null)).toEqual(DAO);
  });

  it("đúng tên ⇒ đúng một đảo; tên lạ ⇒ rỗng để main thoát 3, không xanh rỗng", () => {
    for (const d of DAO) expect(locDaoTheoTen(DAO, d.ten)).toEqual([d]);
    expect(locDaoTheoTen(DAO, "khong-co")).toEqual([]);
  });
});
