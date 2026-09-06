// Sổ cho ba phép kiểm khai báo mới của scripts/check-test-matrix.mjs.
//
// Bộ đột biến trên FILE THẬT (8 ca: job không tồn tại · mất expiry · expiry hết
// hạn · mất blockedFromCi · matrix bỏ cờ · matrix thừa cờ · CI thêm cờ · đổi tên
// bước ⇒ exit 3) đã chạy tay lúc thêm gate và bắt đủ 8/8. Không đưa nó vào đây
// vì nó ghi đè ci-gates.yml và test chạy song song sẽ giẫm lên nhau.
//
// Cái ghim ở đây là hai thứ dễ mục hơn: hàm bóc cờ `--exclude` (phần dễ viết sai
// nhất) và các bất biến khai báo mà gate dựa vào.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";

import { coExcludeCuaBuoc, jobCuaWorkflow, lenhCuaBuoc } from "../check-test-matrix.mjs";

const matrix = JSON.parse(readFileSync(new URL("../../tooling/test-matrix.json", import.meta.url), "utf8"));
const CI = ".github/workflows/ci-gates.yml";

describe("coExcludeCuaBuoc", () => {
  const dung = (run, name = "B") => yaml.load(`jobs:\n  j:\n    steps:\n      - name: ${name}\n        run: ${run}\n`);

  it("bóc được cờ trong chuỗi gấp `run: >` — đây là dạng thật trong ci-gates.yml", () => {
    const doc = dung(">\n          npx vitest run src\n          --exclude 'a/**'\n          --exclude 'b/**'");
    expect(coExcludeCuaBuoc(doc, "B")).toEqual(["a/**", "b/**"]);
  });

  it("nhận cả nháy kép và không nháy", () => {
    const doc = dung(`npx vitest --exclude "a/**" --exclude b/**`);
    expect(coExcludeCuaBuoc(doc, "B")).toEqual(["a/**", "b/**"]);
  });

  it("bước KHÔNG TỒN TẠI trả null, KHÔNG trả [] — hai thứ này khác nhau", () => {
    // Nếu trả [] thì đổi tên bước sẽ đọc thành "CI không loại gì" và gate im
    // lặng bỏ qua phép đối chiếu. Gate xử null bằng exit 3 chính vì vậy.
    expect(coExcludeCuaBuoc(dung("npx vitest --exclude 'a/**'"), "Ten khac")).toBeNull();
  });

  it("bước có thật nhưng không có cờ nào trả [] — phân biệt được với null", () => {
    expect(coExcludeCuaBuoc(dung("npx vitest run src"), "B")).toEqual([]);
  });
});

describe("jobCuaWorkflow", () => {
  it("đọc được job của ci-gates.yml", () => {
    const jobs = jobCuaWorkflow(CI);
    expect(jobs).not.toBeNull();
    expect(jobs.has("quality-gates")).toBe(true);
  });

  it("file không tồn tại trả null (không ném, không trả tập rỗng giả vờ hợp lệ)", () => {
    expect(jobCuaWorkflow(".github/workflows/khong-co-that.yml")).toBeNull();
  });
});

describe("lenhCuaBuoc", () => {
  const doc = yaml.load("jobs:\n  demo:\n    steps:\n      - name: Controlled\n        run: node --test a.test.mjs b.test.mjs\n");

  it("trả đúng lệnh của step trong đúng job", () => {
    expect(lenhCuaBuoc(doc, "demo", "Controlled")).toBe("node --test a.test.mjs b.test.mjs");
  });

  it("trả null nếu job hoặc step không tồn tại", () => {
    expect(lenhCuaBuoc(doc, "other", "Controlled")).toBeNull();
    expect(lenhCuaBuoc(doc, "demo", "Other")).toBeNull();
  });
});

describe("bất biến khai báo của test-matrix.json", () => {
  it("mọi suite đều khai ciJobs — thiếu là gate không biết đối chiếu vào đâu", () => {
    for (const s of matrix.suites) {
      expect(Array.isArray(s.ciJobs), `${s.id} phải có ciJobs`).toBe(true);
    }
  });

  it("suite không chạy CI phải có reason + expiry + exitCondition", () => {
    for (const s of matrix.suites.filter((x) => (x.ciJobs ?? []).length === 0)) {
      expect(s.blockedFromCi?.reason?.length, `${s.id}`).toBeGreaterThan(29);
      expect(s.blockedFromCi?.expiry, `${s.id}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(s.blockedFromCi?.exitCondition, `${s.id}`).toBeTruthy();
    }
  });

  it("app-unit khai đúng tập cờ --exclude của bước Vitest thật", () => {
    const s = matrix.suites.find((x) => x.id === "app-unit");
    const doc = yaml.load(readFileSync(new URL(`../../${CI}`, import.meta.url), "utf8"));
    const that = coExcludeCuaBuoc(doc, s.ciVitestStep);
    expect(that, "không tìm thấy bước Vitest — phép đối chiếu đã mất neo").not.toBeNull();
    expect([...s.excludes].sort()).toEqual([...that].sort());
  });

  it("suite có ciCommandStep khai đúng lệnh đang chạy trong workflow", () => {
    for (const s of matrix.suites.filter((suite) => suite.ciCommandStep)) {
      const target = s.ciJobs[0];
      const doc = yaml.load(readFileSync(new URL(`../../${target.workflow}`, import.meta.url), "utf8"));
      expect(lenhCuaBuoc(doc, target.job, s.ciCommandStep), s.id).toBe(s.command);
    }
  });

  it("chống-xanh-rỗng: đủ 5 suite và bước Vitest loại ít nhất 9 đường", () => {
    // Sàn này tồn tại vì hai ca trên vẫn xanh khi cả hai phía cùng rỗng.
    // Hạ 9→5 và 12→9 ngày 30/08/2026: xóa OpenClaw rút 6 suite + 3 cờ exclude —
    // teo THẬT do xóa hệ con, không phải hai phía cùng rỗng.
    expect(matrix.suites.length).toBeGreaterThanOrEqual(5);
    expect(matrix.suites.find((x) => x.id === "app-unit").excludes.length).toBeGreaterThanOrEqual(9);
  });
});
