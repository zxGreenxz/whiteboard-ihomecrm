// Test cho phần dọn bản cũ và kiểm hạn của cơ chế backup.
//
// Bối cảnh: 07/08/2026 cơ chế backup HỎNG mà không ai biết — pg_dump đứt giữa
// chừng ở bảng lớn nhất, và mọi báo cáo trước đó vẫn ghi "backup đã chạy thật".
// Hai hàm dưới đây là phần canh chừng cho việc đó, nên chúng cần test riêng.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chonBanCanXoa } from "../backup-before-schema.mjs";
import { banMoiNhat } from "../check-backup-freshness.mjs";

const ten = (iso) => `ihomecrm-full-${iso}.dump`;

describe("chonBanCanXoa — giữ N bản mới nhất", () => {
  it("dưới ngưỡng thì không xoá gì", () => {
    const f = [ten("2026-08-01"), ten("2026-08-02")];
    assert.deepEqual(chonBanCanXoa(f, 5), []);
  });

  it("vượt ngưỡng thì xoá đúng bản CŨ nhất", () => {
    const f = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04"].map(ten);
    assert.deepEqual(chonBanCanXoa(f, 2), [ten("2026-08-02"), ten("2026-08-01")]);
  });

  it("không đụng file lạ trong cùng thư mục", () => {
    // Manifest .json và nhật ký nằm cùng chỗ — xoá nhầm chúng là mất bằng chứng.
    const f = [ten("2026-08-01"), ten("2026-08-02"), `${ten("2026-08-01")}.json`, "nhat-ky.log"];
    assert.deepEqual(chonBanCanXoa(f, 1), [ten("2026-08-01")]);
  });

  it("bản schema-only cũng nằm trong diện dọn", () => {
    const f = [ten("2026-08-03"), "ihomecrm-schema-2026-08-01.dump"];
    assert.deepEqual(chonBanCanXoa(f, 1), ["ihomecrm-schema-2026-08-01.dump"]);
  });
});

describe("banMoiNhat — tìm bản mới nhất và tuổi của nó", () => {
  const NGAY = 86_400_000;
  const bayGio = Date.UTC(2026, 7, 7);

  it("chọn bản có timestamp lớn nhất, không phải bản đầu danh sách", () => {
    const f = [ten("2026-08-05"), ten("2026-08-01"), ten("2026-08-03")];
    const r = banMoiNhat(f, () => ({ mtimeMs: bayGio, size: 100 }), bayGio);
    assert.equal(r.ten, ten("2026-08-05"));
  });

  it("tính đúng tuổi theo ngày", () => {
    const r = banMoiNhat([ten("2026-08-01")], () => ({ mtimeMs: bayGio - 3 * NGAY, size: 1 }), bayGio);
    assert.equal(Math.round(r.tuoiNgay), 3);
  });

  it("không có bản nào ⇒ null (KHÔNG phải 'ổn')", () => {
    assert.equal(banMoiNhat(["nhat-ky.log"], () => ({ mtimeMs: 0, size: 0 }), bayGio), null);
  });

  it("bỏ qua bản schema-only — nó KHÔNG phải đường lùi", () => {
    // Dump chỉ schema không khôi phục được dữ liệu; nhận nhầm nó là backup hợp lệ
    // sẽ cho cảm giác an toàn sai đúng lúc nguy hiểm nhất.
    const f = ["ihomecrm-schema-2026-08-07.dump", ten("2026-08-01")];
    const r = banMoiNhat(f, () => ({ mtimeMs: bayGio, size: 1 }), bayGio);
    assert.equal(r.ten, ten("2026-08-01"));
  });
});
