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
import {
  interpretProtection,
  danhGiaVercel,
  trangThaiNhanhPhatHanh,
  UNVERIFIED,
} from "../check-external-controls.mjs";

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
