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
import { interpretProtection, danhGiaVercel, UNVERIFIED } from "../check-external-controls.mjs";

const ok = (data) => ({ ok: true, data });

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
  it("production branch = main ⇒ failed", () => {
    // Kịch bản thật: ai đó vào dashboard Vercel gạt production branch từ
    // 'production' về 'main' ⇒ mọi push vào main lại là một lần phát hành.
    const r = danhGiaVercel([{ name: "ihomecrm", productionBranch: "main" }]);
    assert.equal(r.status, "failed");
  });

  it("productionBranch null (mặc định = main) ⇒ failed", () => {
    assert.equal(danhGiaVercel([{ name: "ihomecrm", productionBranch: null }]).status, "failed");
  });

  it("production branch đúng ⇒ checked", () => {
    assert.equal(
      danhGiaVercel([{ name: "ihomecrm", productionBranch: "production" }]).status,
      "checked",
    );
  });

  it("một project sai trong nhiều project ⇒ failed", () => {
    const r = danhGiaVercel([
      { name: "a", productionBranch: "production" },
      { name: "b", productionBranch: "main" },
    ]);
    assert.equal(r.status, "failed");
    assert.match(r.note, /b→main/);
  });

  it("0 project ⇒ unverified, KHÔNG phải checked (token sai team cũng trả 200)", () => {
    assert.equal(danhGiaVercel([]).status, UNVERIFIED);
  });
});
