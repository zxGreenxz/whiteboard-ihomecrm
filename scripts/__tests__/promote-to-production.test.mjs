// Sổ cho phần đánh giá của scripts/promote-to-production.mjs.
//
// Ca quan trọng nhất: một bước FAIL bên trong một job `continue-on-error` làm
// GitHub đặt `conclusion: failure` cho BƯỚC nhưng `success` cho JOB. Mọi công cụ
// đọc kết luận ở mức job — kể cả trang Checks của GitHub — hiển thị màu xanh.
//
// Repo này CÓ dùng continue-on-error (đăng ký ở tooling/known-gaps.yaml), nên
// đây không phải rủi ro lý thuyết: nếu promote đọc mức job thì nó sẽ phát hành
// một commit có gate đỏ và không ai thấy gì bất thường.
import { describe, expect, it } from "vitest";

import { danhGiaJobs, locRunsDanhGia } from "../promote-to-production.mjs";

const buoc = (name, conclusion, status = "completed") => ({ name, conclusion, status });
// `status` mặc định "completed": phần lớn ca nói về job đã xong. Ca job đang
// chạy khai status tường minh — chính ca đó đã bắt được lỗi xếp nhầm loại.
const job = (name, conclusion, steps, status = "completed") => ({ name, conclusion, steps, status });

describe("locRunsDanhGia", () => {
  // Cú push `production` kích hoạt CI mới trên nhánh đó — gồm cả run đang chạy
  // chính script promote. Không lọc thì script chấm điểm run chứa chính nó
  // (không bao giờ completed khi đang chấm) ⇒ job promotion đỏ VĨNH VIỄN trên
  // nhánh production. Đo thật 13/08/2026, run 31722280140: cùng SHA xanh trọn
  // trên main mà job này đỏ vì 51 bước "chưa xong" toàn của các run tiếng-vọng.
  it("loại run trên nhánh production — kể cả run đang chạy chính script này", () => {
    const runs = [
      { id: 1, head_branch: "main", status: "completed" },
      { id: 2, head_branch: "production", status: "in_progress" },
      { id: 3, head_branch: "production", status: "completed" },
    ];
    expect(locRunsDanhGia(runs).map((r) => r.id)).toEqual([1]);
  });

  it("không còn run nào sau khi lọc ⇒ trả rỗng để main() fail closed (exit 3)", () => {
    expect(locRunsDanhGia([{ id: 2, head_branch: "production" }])).toEqual([]);
    expect(locRunsDanhGia(undefined)).toEqual([]);
  });
});

describe("danhGiaJobs", () => {
  it("mọi bước xanh ⇒ đủ điều kiện promote", () => {
    const kq = danhGiaJobs([job("ci / gates", "success", [buoc("a", "success"), buoc("b", "success")])]);
    expect(kq.datDieuKien).toBe(true);
    expect(kq.doGate).toEqual([]);
    expect(kq.nuot).toEqual([]);
  });

  it("BƯỚC fail mà JOB success ⇒ bắt được, xếp vào nhóm `nuot`", () => {
    // Đây chính là hình dạng mà continue-on-error tạo ra.
    const kq = danhGiaJobs([job("ci / gates", "success", [buoc("gate X", "failure")])]);
    expect(kq.datDieuKien).toBe(false);
    expect(kq.nuot).toEqual(["ci / gates › gate X"]);
    expect(kq.doGate).toEqual([]); // tách riêng: nó KHÁC một job đỏ bình thường
  });

  it("bước fail và job cũng fail ⇒ nhóm `doGate`, không lẫn vào `nuot`", () => {
    const kq = danhGiaJobs([job("ci / gates", "failure", [buoc("gate Y", "failure")])]);
    expect(kq.doGate).toEqual(["ci / gates › gate Y"]);
    expect(kq.nuot).toEqual([]);
  });

  it("timed_out cũng là fail — hết giờ không phải là qua", () => {
    const kq = danhGiaJobs([job("ci", "success", [buoc("chậm", "timed_out")])]);
    expect(kq.nuot).toEqual(["ci › chậm"]);
  });

  it("bước CHƯA XONG ⇒ chưa kết luận được, KHÔNG đọc thành xanh", () => {
    const kq = danhGiaJobs([job("ci", null, [buoc("đang chạy", null, "in_progress")], "in_progress")]);
    expect(kq.datDieuKien).toBe(false);
    expect(kq.dangChay).toEqual(["ci › đang chạy"]);
  });

  it("job đỏ mà KHÔNG bước nào đỏ (huỷ, runner chết) vẫn bị chặn", () => {
    // Nếu chỉ duyệt bước thì ca này lọt: danh sách bước rỗng hoặc toàn success.
    const kq = danhGiaJobs([job("ci", "cancelled", [buoc("a", "success")])]);
    expect(kq.datDieuKien).toBe(false);
    expect(kq.doGate[0]).toContain("cancelled");
  });

  it("job `skipped` không bị tính là đỏ", () => {
    expect(danhGiaJobs([job("ci", "skipped", [])]).datDieuKien).toBe(true);
  });

  it("không có job nào ⇒ đủ điều kiện theo hàm này — chặn nằm ở phía gọi", () => {
    // Hàm thuần không biết "0 job" là bất thường; phía gọi thoát 3 khi API trả
    // rỗng. Ghim ranh giới trách nhiệm đó ở đây để không ai nhét sàn vào nhầm chỗ.
    expect(danhGiaJobs([]).datDieuKien).toBe(true);
  });

  it("nhiều job trộn lẫn: gom đủ cả ba nhóm, không nhóm nào nuốt nhóm nào", () => {
    const kq = danhGiaJobs([
      job("w1 / a", "success", [buoc("ok", "success"), buoc("nuot", "failure")]),
      job("w1 / b", "failure", [buoc("do", "failure")]),
      job("w2 / c", null, [buoc("cho", null, "queued")], "in_progress"),
    ]);
    expect(kq.nuot).toEqual(["w1 / a › nuot"]);
    expect(kq.doGate).toEqual(["w1 / b › do"]);
    expect(kq.dangChay).toEqual(["w2 / c › cho"]);
    expect(kq.datDieuKien).toBe(false);
  });
});
