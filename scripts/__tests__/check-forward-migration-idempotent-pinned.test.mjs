import { describe, expect, it } from "vitest";

import { danhGiaMienTruPinned, docLoiSql, kiemMienTruPinned } from "../check-forward-migration-idempotent.mjs";

const file = "20260909172332_reservation_deposit_settlement_v1.sql";
const digest = "32008e7d10b730ceef4840fb307288e033be5d868842597ed30f27136e6da2e6";
const entry = {
  sha256: digest,
  expectedSqlState: "42P07",
  expectedMessage: 'relation "reservation_deposit_settlements" already exists',
  appliedEvidencePath: "docs/generated/schema-change-evidence/evidence.json",
};
const evidence = {
  file: `supabase/migrations/${file}`,
  sha256: digest,
  appliedAt: "2026-09-10T01:02:03.000Z",
  projectRef: "tryymsxyyckgbrmmvozx",
  authorization: { loai: "bien-nhan-backup", chiTiet: "16d825" },
};
const failureText = JSON.stringify({ code: "42P07", message: entry.expectedMessage });
const read = () => JSON.stringify(evidence);

describe("ngoại lệ idempotency pinned", () => {
  it("chỉ EXEMPT khi digest, lỗi SQL và evidence đều khớp chính xác", () => {
    expect(kiemMienTruPinned({ entry, file, digest, failureText, root: "C:/repo", read })).toMatchObject({ ok: true });
  });

  it("không đổi ngoại lệ pinned thành PASS khi migration bất ngờ chạy lại được", () => {
    expect(danhGiaMienTruPinned({ entry, file, digest, failureText: "", queryOk: true, root: "C:/repo", read })).toMatchObject({
      ok: false, vi: expect.stringMatching(/không được coi là idempotent PASS/),
    });
  });

  it.each([
    ["digest", { digest: "sai" }, /sha256/],
    ["SQLSTATE", { failureText: JSON.stringify({ code: "42703", message: entry.expectedMessage }) }, /lỗi thực tế/],
    ["message", { failureText: JSON.stringify({ code: "42P07", message: "khác" }) }, /lỗi thực tế/],
  ])("từ chối khi %s lệch pin", (_name, changed, expected) => {
    expect(kiemMienTruPinned({ entry, file, digest, failureText, root: "C:/repo", read, ...changed })).toMatchObject({ ok: false, vi: expect.stringMatching(expected) });
  });

  it("từ chối path traversal", () => {
    expect(kiemMienTruPinned({ entry: { ...entry, appliedEvidencePath: "../evidence.json" }, file, digest, failureText, root: "C:/repo", read })).toMatchObject({ ok: false, vi: expect.stringMatching(/không an toàn/) });
  });

  it("từ chối evidence thiếu giấy phép apply thật", () => {
    const readBad = () => JSON.stringify({ ...evidence, authorization: { loai: "tu-khai" } });
    expect(kiemMienTruPinned({ entry, file, digest, failureText, root: "C:/repo", read: readBad })).toMatchObject({ ok: false, vi: expect.stringMatching(/dấu mốc apply thật/) });
  });

  it("đọc đúng lỗi JSON của Management API", () => {
    expect(docLoiSql(failureText)).toEqual({ sqlState: "42P07", message: entry.expectedMessage });
  });
});
