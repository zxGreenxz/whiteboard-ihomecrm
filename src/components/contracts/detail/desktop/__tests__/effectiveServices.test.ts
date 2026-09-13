import { describe, expect, it } from "vitest";

import type { ContractServiceItem } from "@/components/contracts/detail/types";
import { dichVuHieuLuc, type DichVuToaLite } from "../effectiveServices";

const dvHopDong = (
  over: Partial<ContractServiceItem> & { id: string; ten: string; gia: number },
): ContractServiceItem => ({
  id: over.id,
  service_id: `s-${over.id}`,
  unit_price: over.gia,
  initial_reading: over.initial_reading ?? null,
  service: {
    id: `s-${over.id}`,
    name: over.ten,
    type: "FIXED",
    unit: "Phòng",
    ...(over.service ?? {}),
  },
});

const dvToa = (
  id: string,
  ten: string,
  gia: number,
  over: Partial<DichVuToaLite> = {},
): DichVuToaLite => ({
  id,
  is_active: true,
  unit_price_override: null,
  service: { id: `s-${id}`, name: ten, type: "FIXED", unit: "Phòng", unit_price: gia },
  ...over,
});

describe("dichVuHieuLuc — nguồn giá nào đang thật sự áp dụng", () => {
  it("HĐ có khai dịch vụ riêng thì dùng giá của HĐ", () => {
    const kq = dichVuHieuLuc({
      contractServices: [dvHopDong({ id: "1", ten: "Điện", gia: 3500 })],
      buildingServices: [dvToa("b1", "Điện 3k9", 3900)],
    });
    expect(kq.nguon).toBe("HD");
    expect(kq.dong).toHaveLength(1);
    expect(kq.dong[0]?.donGia).toBe(3500);
  });

  it("HĐ KHÔNG khai gì thì rơi về bảng giá của toà — không phải 'không có dịch vụ'", () => {
    // Đây là ca của 238/291 HĐ đang hoạt động trên prod (82%). Nói "chưa đăng ký
    // dịch vụ nào" với các HĐ này là sai: hoá đơn vẫn thu tiền nước + phí dịch
    // vụ theo giá toà (xem contractServicePricing.ts — luật fallback).
    const kq = dichVuHieuLuc({
      contractServices: [],
      buildingServices: [
        dvToa("b1", "Điện 3k9 - 950NK", 3900),
        dvToa("b2", "Nước", 100000),
        dvToa("b3", "Phí Dịch Vụ TL", 200000),
      ],
    });
    expect(kq.nguon).toBe("TOA");
    expect(kq.dong.map((d) => d.ten)).toEqual([
      "Điện 3k9 - 950NK",
      "Nước",
      "Phí Dịch Vụ TL",
    ]);
    expect(kq.dong.map((d) => d.donGia)).toEqual([3900, 100000, 200000]);
  });

  it("dịch vụ toà đang TẮT thì không tính — toà 950NK có 13 khai mà chỉ 3 bật", () => {
    const kq = dichVuHieuLuc({
      contractServices: [],
      buildingServices: [
        dvToa("b1", "Điện 3k9 - 950NK", 3900),
        dvToa("b2", "Điện 3K1", 3100, { is_active: false }),
        dvToa("b3", "PDV", 150000, { is_active: false }),
      ],
    });
    expect(kq.dong.map((d) => d.ten)).toEqual(["Điện 3k9 - 950NK"]);
  });

  it("giá riêng của toà (unit_price_override) thắng giá gốc của dịch vụ", () => {
    const kq = dichVuHieuLuc({
      contractServices: [],
      buildingServices: [dvToa("b1", "Nước", 100000, { unit_price_override: 120000 })],
    });
    expect(kq.dong[0]?.donGia).toBe(120000);
  });

  it("override bằng 0 vẫn là một mức giá hợp lệ, không được coi là 'chưa đặt'", () => {
    const kq = dichVuHieuLuc({
      contractServices: [],
      buildingServices: [dvToa("b1", "Gửi xe", 150000, { unit_price_override: 0 })],
    });
    expect(kq.dong[0]?.donGia).toBe(0);
  });

  it("cả hai nguồn đều rỗng thì mới là thật sự không có dịch vụ", () => {
    const kq = dichVuHieuLuc({ contractServices: [], buildingServices: [] });
    expect(kq.nguon).toBeNull();
    expect(kq.dong).toEqual([]);
  });

  it("chỉ số đầu chỉ có ở dịch vụ khai theo HĐ", () => {
    const kq = dichVuHieuLuc({
      contractServices: [dvHopDong({ id: "1", ten: "Điện", gia: 3500, initial_reading: 1248 })],
      buildingServices: [],
    });
    expect(kq.dong[0]?.chiSoDau).toBe(1248);

    const kqToa = dichVuHieuLuc({
      contractServices: [],
      buildingServices: [dvToa("b1", "Điện", 3900)],
    });
    expect(kqToa.dong[0]?.chiSoDau).toBeNull();
  });
});
