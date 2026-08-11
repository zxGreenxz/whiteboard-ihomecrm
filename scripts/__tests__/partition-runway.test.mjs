// Sổ cho scripts/check-partition-runway.mjs.
//
// `network_device_samples` và `network_interface_samples` phân mảnh theo NGÀY.
// Partition phải được tạo TRƯỚC; nếu không ai gọi
// `app_private.network_center_ensure_raw_partitions_v1`, partition mới nhất lùi
// dần về hôm nay — và đúng ngày nó tụt lại phía sau, MỌI insert telemetry lỗi
// cùng lúc (`no partition of relation ... found for row`).
//
// Hỏng theo kiểu tệ: không hỏng dần. Hôm nay tốt, ngày mai chết sạch, và thời
// điểm chết là một ngày trong tương lai mà không ai có lịch để nhớ.
import { describe, expect, it } from "vitest";

import { SAN_NGAY, duPhong, ngayTuTenPartition } from "../check-partition-runway.mjs";

const MOC = new Date(Date.UTC(2026, 7, 11)); // 11/08/2026

describe("ngayTuTenPartition", () => {
  it("bóc ngày từ hậu tố YYYYMMDD", () => {
    expect(ngayTuTenPartition("network_device_samples_20260911")?.toISOString().slice(0, 10))
      .toBe("2026-09-11");
  });

  it("tên KHÔNG mang ngày trả null, không đoán bừa", () => {
    // Index và pkey của bảng phân mảnh cũng là con của bảng cha, nhưng tên chúng
    // bị Postgres cắt ngắn nên không còn hậu tố ngày. Đoán bừa ở đây sẽ tạo ra
    // những ngày không tồn tại rồi tính sai dự phòng.
    expect(ngayTuTenPartition("network_device_samples_pkey")).toBeNull();
    expect(ngayTuTenPartition("network_device_samples_202607_organization_id__idx1")).toBeNull();
  });

  it("ngày không hợp lệ trả null", () => {
    expect(ngayTuTenPartition("x_20261332")?.toISOString().slice(0, 10)).not.toBe("2026-13-32");
  });
});

describe("duPhong", () => {
  const ten = (...ngay) => ngay.map((d) => `t_${d}`);

  it("tính đúng số ngày phía trước và số ngày giữ lại", () => {
    const d = duPhong(ten("20260728", "20260811", "20260911"), MOC);
    expect(d.ngayPhiaTruoc).toBe(31);
    expect(d.ngayGiuLai).toBe(14);
    expect(d.so).toBe(3);
  });

  it("partition muộn nhất là HÔM NAY ⇒ 0 ngày phía trước, dưới sàn", () => {
    const d = duPhong(ten("20260811"), MOC);
    expect(d.ngayPhiaTruoc).toBe(0);
    expect(d.ngayPhiaTruoc).toBeLessThan(SAN_NGAY);
  });

  it("partition muộn nhất ĐÃ QUA ⇒ số âm, không phải 0", () => {
    // Số âm nói rõ đã trễ bao nhiêu ngày. Kẹp về 0 sẽ làm "trễ 5 ngày" trông
    // giống "vừa đủ hôm nay".
    expect(duPhong(ten("20260806"), MOC).ngayPhiaTruoc).toBe(-5);
  });

  it("đúng sàn 7 ngày thì ĐẠT, 6 ngày thì không", () => {
    expect(duPhong(ten("20260818"), MOC).ngayPhiaTruoc).toBe(SAN_NGAY);
    expect(duPhong(ten("20260817"), MOC).ngayPhiaTruoc).toBeLessThan(SAN_NGAY);
  });

  it("bỏ qua tên không mang ngày, chỉ tính partition thật", () => {
    const d = duPhong([...ten("20260911"), "t_pkey", "t_idx1"], MOC);
    expect(d.so).toBe(1);
    expect(d.ngayPhiaTruoc).toBe(31);
  });

  it("danh sách KHÔNG có tên nào mang ngày ⇒ null (phép đo hỏng, không phải 0 ngày)", () => {
    expect(duPhong(["t_pkey", "t_idx1"], MOC)).toBeNull();
  });
});
