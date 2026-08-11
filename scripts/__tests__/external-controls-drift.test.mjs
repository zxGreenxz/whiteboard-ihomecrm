// Sổ cho phép so "kiểm soát ngoài repo có đổi không" (--so-ban-commit).
//
// Vì sao phép so này phải LỌC trước khi so: bằng chứng chứa `checkedAt` (đổi mỗi
// lượt chạy) và SHA/state deployment (đổi mỗi lần phát hành). So thô thì job định
// kỳ đỏ thường trực — và một job đỏ thường trực là job người ta ngừng đọc, lúc đó
// control có bị tắt thật cũng không ai thấy.
//
// Nhưng lọc quá tay thì gate thành mù. Bộ ca dưới đây canh đúng ranh giới ấy.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { lechSoVoiCommit, locPhanOnDinh } from "../check-external-controls.mjs";

const GOC = JSON.parse(
  readFileSync(new URL("../../docs/generated/external-controls.json", import.meta.url), "utf8"),
);
const ban = () => JSON.parse(JSON.stringify(GOC));

describe("locPhanOnDinh", () => {
  it("bỏ checkedAt", () => {
    expect(locPhanOnDinh(GOC).checkedAt).toBeUndefined();
  });

  it("bỏ sha/state/ancestorOfMain của deployment nhưng GIỮ phần còn lại", () => {
    const c = locPhanOnDinh(GOC).controls.vercelEnvAndDeployment;
    expect(c.productionDeployment.sha).toBeUndefined();
    expect(c.productionDeployment.state).toBeUndefined();
    // `ref` ở lại: nó nói production deploy TỪ NHÁNH NÀO — đó là cấu hình, không
    // phải kết quả một lần build.
    expect(c.productionDeployment.ref).toBeDefined();
    expect(c.envVarNames.length).toBeGreaterThan(0);
  });

  it("KHÔNG sửa bản gốc — phép lọc phải thuần", () => {
    const truoc = JSON.stringify(GOC);
    locPhanOnDinh(GOC);
    expect(JSON.stringify(GOC)).toBe(truoc);
  });
});

describe("lechSoVoiCommit — cái gì được bỏ qua, cái gì phải kêu", () => {
  it("đổi checkedAt + sha + state deployment ⇒ KHÔNG kêu", () => {
    const a = ban();
    a.checkedAt = "2099-01-01T00:00:00.000Z";
    a.controls.vercelEnvAndDeployment.productionDeployment.sha = "deadbeef";
    a.controls.vercelEnvAndDeployment.productionDeployment.state = "BUILDING";
    expect(lechSoVoiCommit(a, GOC)).toEqual([]);
  });

  it("đổi NHÁNH PRODUCTION của một project ⇒ kêu", () => {
    // Đây là control quan trọng nhất trong file: nhánh nào deploy ra sản phẩm thật.
    const a = ban();
    a.controls.vercelProductionBranch.projects[1].productionBranch = "main";
    expect(lechSoVoiCommit(a, GOC).length).toBeGreaterThan(0);
  });

  it("thêm một env var production ⇒ kêu", () => {
    const a = ban();
    a.controls.vercelEnvAndDeployment.envVarNames.push({ key: "MOI", target: "production", type: "plain" });
    expect(lechSoVoiCommit(a, GOC).length).toBeGreaterThan(0);
  });

  it("đổi status branch protection ⇒ kêu", () => {
    const a = ban();
    a.controls.githubBranchProtection.status = "failed";
    expect(lechSoVoiCommit(a, GOC).length).toBeGreaterThan(0);
  });

  it("XOÁ hẳn một control ⇒ kêu — mất control không được đọc thành 'không đổi'", () => {
    const a = ban();
    delete a.controls.vercelProductionBranch;
    expect(lechSoVoiCommit(a, GOC).length).toBeGreaterThan(0);
  });

  it("hai bản y hệt ⇒ rỗng", () => {
    expect(lechSoVoiCommit(ban(), GOC)).toEqual([]);
  });

  it("chống-xanh-rỗng: bằng chứng thật có đủ control để phép so có nghĩa", () => {
    expect(Object.keys(GOC.controls).length).toBeGreaterThanOrEqual(4);
  });
});
